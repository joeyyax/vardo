import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tasks, projects, taskRelationships, users, TASK_STATUSES, type TaskStatus } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { logTaskStatusChanged, logTaskAssigned } from "@/lib/activities";
import { notifyAssignment, notifyStatusChange } from "@/lib/notifications";

// Check if a task has unresolved blockers
async function hasUnresolvedBlockers(taskId: string): Promise<{ blocked: boolean; blockers: { id: string; name: string; status: TaskStatus | null }[] }> {
  const blockerRelations = await db.query.taskRelationships.findMany({
    where: and(
      eq(taskRelationships.sourceTaskId, taskId),
      eq(taskRelationships.type, "blocked_by")
    ),
    with: {
      targetTask: {
        columns: { id: true, name: true, status: true },
      },
    },
  });

  const unresolvedBlockers = blockerRelations
    .filter((r) => r.targetTask.status !== "done")
    .map((r) => r.targetTask);

  return {
    blocked: unresolvedBlockers.length > 0,
    blockers: unresolvedBlockers,
  };
}

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; taskId: string }>;
};

/**
 * Verify that the project belongs to the organization.
 * Returns the project if valid, null otherwise.
 */
async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: true,
    },
  });

  if (!project || project.client.organizationId !== orgId) {
    return null;
  }

  return project;
}

/**
 * Verify that the task belongs to the project.
 * Returns the task if valid, null otherwise.
 */
async function verifyTaskBelongsToProject(taskId: string, projectId: string) {
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)),
  });

  return task || null;
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify project belongs to org
    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Fetch task with all related data
    const task = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)),
      with: {
        type: {
          columns: { id: true, name: true, color: true, icon: true, defaultFields: true },
        },
        assignedToUser: {
          columns: { id: true, name: true, email: true },
        },
        createdByUser: {
          columns: { id: true, name: true, email: true },
        },
        tagAssignments: {
          with: {
            tag: {
              columns: { id: true, name: true, color: true },
            },
          },
        },
        comments: {
          orderBy: (comments, { desc }) => [desc(comments.createdAt)],
          with: {
            author: {
              columns: { id: true, name: true, email: true },
            },
          },
        },
        watchers: {
          with: {
            user: {
              columns: { id: true, name: true, email: true },
            },
          },
        },
        files: {
          with: {
            file: {
              columns: { id: true, name: true, mimeType: true, sizeBytes: true },
            },
          },
        },
        outgoingRelationships: {
          with: {
            targetTask: {
              columns: { id: true, name: true, status: true },
            },
          },
        },
        incomingRelationships: {
          with: {
            sourceTask: {
              columns: { id: true, name: true, status: true },
            },
          },
        },
      },
    });

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    return NextResponse.json(task);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error fetching task:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId } = await params;
    const { organization, session } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify project belongs to org
    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Verify task belongs to project
    const existingTask = await verifyTaskBelongsToProject(taskId, projectId);
    if (!existingTask) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const body = await request.json();
    const {
      name,
      description,
      rateOverride,
      isBillable,
      isArchived,
      status,
      isRecurring,
      assignedTo,
      position,
      // New fields
      typeId,
      estimateMinutes,
      prLink,
      isClientVisible,
      metadata,
    } = body;

    // Build update object with only provided fields
    const updates: Partial<{
      name: string;
      description: string | null;
      rateOverride: number | null;
      isBillable: boolean | null;
      isArchived: boolean;
      status: TaskStatus | null;
      isRecurring: boolean;
      assignedTo: string | null;
      position: number;
      typeId: string | null;
      estimateMinutes: number | null;
      prLink: string | null;
      isClientVisible: boolean;
      metadata: Record<string, unknown>;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length === 0) {
        return NextResponse.json(
          { error: "Name cannot be empty" },
          { status: 400 }
        );
      }
      updates.name = name.trim();
    }

    if (description !== undefined) {
      updates.description = description?.trim() || null;
    }

    if (rateOverride !== undefined) {
      // Convert rate from dollars to cents if provided, null if empty/null
      updates.rateOverride =
        rateOverride !== null && rateOverride !== "" && rateOverride !== undefined
          ? Math.round(parseFloat(rateOverride) * 100)
          : null;
    }

    if (isBillable !== undefined) {
      updates.isBillable = isBillable;
    }

    if (isArchived !== undefined) {
      updates.isArchived = isArchived;
    }

    if (status !== undefined) {
      if (status !== null && !TASK_STATUSES.includes(status)) {
        return NextResponse.json(
          { error: `Status must be one of: ${TASK_STATUSES.join(", ")}` },
          { status: 400 }
        );
      }

      // Block completion if there are unresolved blockers
      if (status === "done" && existingTask.status !== "done") {
        const { blocked, blockers } = await hasUnresolvedBlockers(taskId);
        if (blocked) {
          return NextResponse.json(
            {
              error: "Cannot complete task: blocked by unresolved tasks",
              blockers: blockers.map((b) => ({ id: b.id, name: b.name })),
            },
            { status: 400 }
          );
        }
      }

      updates.status = status;
    }

    if (isRecurring !== undefined) {
      updates.isRecurring = isRecurring;
    }

    if (assignedTo !== undefined) {
      updates.assignedTo = assignedTo || null;
    }

    if (position !== undefined) {
      updates.position = Number(position);
    }

    // New fields
    if (typeId !== undefined) {
      updates.typeId = typeId || null;
    }

    if (estimateMinutes !== undefined) {
      updates.estimateMinutes = estimateMinutes ? parseInt(estimateMinutes, 10) : null;
    }

    if (prLink !== undefined) {
      updates.prLink = prLink?.trim() || null;
    }

    if (isClientVisible !== undefined) {
      updates.isClientVisible = isClientVisible;
    }

    if (metadata !== undefined) {
      updates.metadata = metadata || {};
    }

    const [updatedTask] = await db
      .update(tasks)
      .set(updates)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
      .returning();

    // Get actor name for notifications
    const actor = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { name: true, email: true },
    });
    const actorName = actor?.name || actor?.email || "Someone";

    // Log activity and notify for status changes
    if (status !== undefined && status !== existingTask.status) {
      await logTaskStatusChanged({
        organizationId: orgId,
        actorId: session.user.id,
        projectId,
        taskId,
        taskName: updatedTask.name,
        fromStatus: existingTask.status,
        toStatus: status,
        isClientVisible: updatedTask.isClientVisible ?? undefined,
      });

      // Notify watchers about status change
      await notifyStatusChange({
        taskId,
        taskName: updatedTask.name,
        actorId: session.user.id,
        actorName,
        fromStatus: existingTask.status,
        toStatus: status,
      });
    }

    // Log activity and notify for assignment changes
    if (assignedTo !== undefined && assignedTo !== existingTask.assignedTo) {
      // Fetch assignee name if assigned
      let assigneeName: string | null = null;
      if (assignedTo) {
        const assignee = await db.query.users.findFirst({
          where: eq(users.id, assignedTo),
          columns: { name: true, email: true },
        });
        assigneeName = assignee?.name || assignee?.email || null;
      }

      await logTaskAssigned({
        organizationId: orgId,
        actorId: session.user.id,
        projectId,
        taskId,
        taskName: updatedTask.name,
        assigneeId: assignedTo || null,
        assigneeName,
        isClientVisible: updatedTask.isClientVisible ?? undefined,
      });

      // Notify assignee
      if (assignedTo) {
        await notifyAssignment({
          assigneeId: assignedTo,
          actorId: session.user.id,
          taskId,
          taskName: updatedTask.name,
          actorName,
        });
      }
    }

    return NextResponse.json(updatedTask);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error updating task:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify project belongs to org
    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Verify task belongs to project
    const existingTask = await verifyTaskBelongsToProject(taskId, projectId);
    if (!existingTask) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    await db
      .delete(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error deleting task:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
