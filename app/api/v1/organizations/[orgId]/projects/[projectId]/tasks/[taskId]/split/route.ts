import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tasks, projects, taskFiles } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, sql } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; taskId: string }>;
};

async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: { client: true },
  });
  if (!project || project.client.organizationId !== orgId) return null;
  return project;
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/split
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const userId = session.user.id;

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Fetch the source task
    const sourceTask = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)),
      with: { files: true },
    });

    if (!sourceTask) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const sourceMeta = (sourceTask.metadata ?? {}) as Record<string, unknown>;
    if (sourceMeta.source !== "widget" && !sourceMeta.bugReportId) {
      return NextResponse.json(
        { error: "Only bug report tasks can be split" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const splitTasks: Array<{ name: string; description?: string; assignedTo?: string }> =
      body.tasks;

    if (!Array.isArray(splitTasks) || splitTasks.length < 2) {
      return NextResponse.json(
        { error: "At least 2 tasks are required" },
        { status: 400 }
      );
    }

    // Get next positions for todo column
    const maxPosResult = await db
      .select({ maxPos: sql<number>`COALESCE(MAX(position), 0)` })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.status, "todo")));
    let nextPosition = (maxPosResult[0]?.maxPos ?? 0) + 1;

    // Create the new tasks
    const createdTasks = [];
    for (const entry of splitTasks) {
      if (!entry.name?.trim()) continue;

      const [newTask] = await db
        .insert(tasks)
        .values({
          projectId,
          name: entry.name.trim(),
          description: entry.description?.trim() || null,
          status: "todo",
          createdBy: userId,
          assignedTo: entry.assignedTo || null,
          position: nextPosition++,
          typeId: sourceTask.typeId,
          metadata: {
            source: sourceMeta.source || undefined,
            bugReportId: sourceMeta.bugReportId || undefined,
            splitFromTaskId: taskId,
          },
        })
        .returning();

      // Link all files from source task to new task
      if (newTask && sourceTask.files && sourceTask.files.length > 0) {
        for (const tf of sourceTask.files) {
          try {
            await db.insert(taskFiles).values({
              taskId: newTask.id,
              fileId: tf.fileId,
            });
          } catch {
            // Ignore duplicate key errors
          }
        }
      }

      createdTasks.push(newTask);
    }

    if (createdTasks.length < 2) {
      return NextResponse.json(
        { error: "Failed to create enough tasks" },
        { status: 400 }
      );
    }

    // Update the source task: mark as split and archive
    const splitIntoTaskIds = createdTasks.map((t) => t.id);
    await db
      .update(tasks)
      .set({
        isArchived: true,
        metadata: {
          ...sourceMeta,
          split: true,
          splitIntoTaskIds,
        },
      })
      .where(eq(tasks.id, taskId));

    return NextResponse.json({ tasks: createdTasks }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error splitting task:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
