import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tasks, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

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

    // Verify task belongs to project
    const task = await verifyTaskBelongsToProject(taskId, projectId);
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

    const body = await request.json();
    const { name, rateOverride, isBillable, isArchived } = body;

    // Build update object with only provided fields
    const updates: Partial<{
      name: string;
      rateOverride: number | null;
      isBillable: boolean | null;
      isArchived: boolean;
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

    const [updatedTask] = await db
      .update(tasks)
      .set(updates)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
      .returning();

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
