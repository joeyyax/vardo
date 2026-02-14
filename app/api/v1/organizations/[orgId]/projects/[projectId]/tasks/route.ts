import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tasks, projects, TASK_STATUSES, TASK_PRIORITIES, type TaskStatus } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, isNull, sql } from "drizzle-orm";
import { logTaskCreated } from "@/lib/activities";
import { ensureWatcher } from "@/lib/notifications";
import { resolveAssignee } from "@/lib/assignment";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
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

// GET /api/v1/organizations/[orgId]/projects/[projectId]/tasks
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
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

    // Check for query params
    const url = new URL(request.url);
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const statusFilter = url.searchParams.get("status"); // 'todo', 'in_progress', 'review', 'done', 'category' (null status)
    const forKanban = url.searchParams.get("forKanban") === "true"; // Order by position for kanban

    // Build where conditions
    const conditions = [eq(tasks.projectId, projectId)];

    if (!includeArchived) {
      conditions.push(eq(tasks.isArchived, false));
    }

    if (statusFilter) {
      if (statusFilter === "category") {
        // Tasks without a status (category-only)
        conditions.push(isNull(tasks.status));
      } else if (TASK_STATUSES.includes(statusFilter as TaskStatus)) {
        conditions.push(eq(tasks.status, statusFilter as TaskStatus));
      }
    }

    const projectTasks = await db.query.tasks.findMany({
      where: and(...conditions),
      orderBy: forKanban
        ? (tasks, { asc }) => [asc(tasks.position), asc(tasks.createdAt)]
        : (tasks, { asc }) => [asc(tasks.name)],
      with: {
        type: {
          columns: { id: true, name: true, color: true, icon: true },
        },
        assignedToUser: {
          columns: { id: true, name: true, email: true },
        },
        tagAssignments: {
          with: {
            tag: {
              columns: { id: true, name: true, color: true },
            },
          },
        },
        files: {
          columns: { taskId: true },
        },
      },
    });

    return NextResponse.json(projectTasks);
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
    console.error("Error fetching tasks:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/tasks
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
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

    const { session } = await requireOrg();
    const body = await request.json();
    const {
      name,
      description,
      rateOverride,
      isBillable,
      status,
      isRecurring,
      assignedTo,
      priority,
      // New fields
      typeId,
      estimateMinutes,
      prLink,
      isClientVisible,
      metadata,
    } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    // Validate status if provided
    if (status !== undefined && status !== null && !TASK_STATUSES.includes(status)) {
      return NextResponse.json(
        { error: `Status must be one of: ${TASK_STATUSES.join(", ")}` },
        { status: 400 }
      );
    }

    // Convert rate from dollars to cents if provided
    const rateInCents =
      rateOverride !== null && rateOverride !== undefined && rateOverride !== ""
        ? Math.round(parseFloat(rateOverride) * 100)
        : null;

    // Get max position for this status to add at end
    const maxPositionResult = await db
      .select({ maxPos: sql<number>`COALESCE(MAX(position), 0)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, projectId),
          status ? eq(tasks.status, status) : isNull(tasks.status)
        )
      );
    const nextPosition = (maxPositionResult[0]?.maxPos ?? 0) + 1;

    const [newTask] = await db
      .insert(tasks)
      .values({
        projectId,
        name: name.trim(),
        description: description?.trim() || null,
        rateOverride: rateInCents,
        isBillable: isBillable ?? null,
        status: status || null,
        priority: priority && TASK_PRIORITIES.includes(priority) ? priority : null,
        isRecurring: isRecurring ?? false,
        assignedTo: assignedTo || await resolveAssignee({
          projectId,
          orgId,
        }),
        createdBy: session.user.id,
        position: nextPosition,
        // New fields
        typeId: typeId || null,
        estimateMinutes: estimateMinutes ? parseInt(estimateMinutes, 10) : null,
        prLink: prLink?.trim() || null,
        isClientVisible: isClientVisible ?? true,
        metadata: metadata || {},
      })
      .returning();

    // Log activity
    await logTaskCreated({
      organizationId: orgId,
      actorId: session.user.id,
      projectId,
      taskId: newTask.id,
      taskName: newTask.name,
      isClientVisible: newTask.isClientVisible ?? undefined,
    });

    // Auto-subscribe creator as watcher
    await ensureWatcher("task", newTask.id, session.user.id, "creator");

    // Auto-subscribe assignee as watcher if assigned
    if (newTask.assignedTo) {
      await ensureWatcher("task", newTask.id, newTask.assignedTo, "assignee");
    }

    return NextResponse.json(newTask, { status: 201 });
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
    console.error("Error creating task:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
