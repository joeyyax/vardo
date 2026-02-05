import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tasks, projects, taskComments, taskWatchers } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc } from "drizzle-orm";
import { logCommentAdded } from "@/lib/activities";
import { notifyComment } from "@/lib/notifications";
import { users } from "@/lib/db/schema";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; taskId: string }>;
};

async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: { client: true },
  });
  if (!project || project.client.organizationId !== orgId) {
    return null;
  }
  return project;
}

async function verifyTaskBelongsToProject(taskId: string, projectId: string) {
  return db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)),
  });
}

// Auto-add commenter as watcher
async function ensureWatcher(taskId: string, userId: string, reason: string) {
  const existing = await db.query.taskWatchers.findFirst({
    where: and(
      eq(taskWatchers.taskId, taskId),
      eq(taskWatchers.userId, userId)
    ),
  });

  if (!existing) {
    await db.insert(taskWatchers).values({
      taskId,
      userId,
      reason,
    });
  }
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/comments
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const task = await verifyTaskBelongsToProject(taskId, projectId);
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // Get all comments for this task with author info
    const comments = await db.query.taskComments.findMany({
      where: eq(taskComments.taskId, taskId),
      with: {
        author: {
          columns: { id: true, name: true, email: true, image: true },
        },
        sharedByUser: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: [desc(taskComments.createdAt)],
    });

    return NextResponse.json(comments);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching comments:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/comments
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const task = await verifyTaskBelongsToProject(taskId, projectId);
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const body = await request.json();
    const { content, isShared } = body;

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    const [comment] = await db
      .insert(taskComments)
      .values({
        taskId,
        authorId: session.user.id,
        content: content.trim(),
        isShared: isShared ?? false,
        sharedAt: isShared ? new Date() : null,
        sharedBy: isShared ? session.user.id : null,
      })
      .returning();

    // Auto-watch on comment
    await ensureWatcher(taskId, session.user.id, "commenter");

    // Log activity
    await logCommentAdded({
      organizationId: orgId,
      actorId: session.user.id,
      projectId,
      taskId,
      taskName: task.name,
      commentId: comment.id,
      isShared: comment.isShared ?? false,
    });

    // Notify watchers about the comment
    const actor = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { name: true, email: true },
    });
    const actorName = actor?.name || actor?.email || "Someone";

    await notifyComment({
      taskId,
      taskName: task.name,
      actorId: session.user.id,
      actorName,
      isShared: comment.isShared ?? false,
    });

    // Fetch the full comment with author info
    const fullComment = await db.query.taskComments.findFirst({
      where: eq(taskComments.id, comment.id),
      with: {
        author: {
          columns: { id: true, name: true, email: true, image: true },
        },
        sharedByUser: {
          columns: { id: true, name: true, email: true },
        },
      },
    });

    return NextResponse.json(fullComment, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
