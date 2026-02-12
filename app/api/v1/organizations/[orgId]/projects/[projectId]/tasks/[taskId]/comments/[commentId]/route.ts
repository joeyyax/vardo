import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tasks, projects, taskComments } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; taskId: string; commentId: string }>;
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

// GET /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/comments/[commentId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId, commentId } = await params;
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

    const comment = await db.query.taskComments.findFirst({
      where: and(
        eq(taskComments.id, commentId),
        eq(taskComments.taskId, taskId)
      ),
      with: {
        author: {
          columns: { id: true, name: true, email: true, image: true },
        },
        sharedByUser: {
          columns: { id: true, name: true, email: true },
        },
        pinnedByUser: {
          columns: { id: true, name: true, email: true },
        },
      },
    });

    if (!comment) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }

    return NextResponse.json(comment);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/comments/[commentId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId, commentId } = await params;
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

    const existingComment = await db.query.taskComments.findFirst({
      where: and(
        eq(taskComments.id, commentId),
        eq(taskComments.taskId, taskId)
      ),
    });

    if (!existingComment) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }

    const body = await request.json();
    const { content, isShared, isPinned } = body;

    // Build updates
    const updates: Partial<{
      content: string;
      isShared: boolean;
      sharedAt: Date | null;
      sharedBy: string | null;
      isPinned: boolean;
      pinnedAt: Date | null;
      pinnedBy: string | null;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    // Content update - only author can edit content
    if (content !== undefined) {
      if (existingComment.authorId !== session.user.id) {
        return NextResponse.json(
          { error: "Only the author can edit comment content" },
          { status: 403 }
        );
      }
      if (typeof content !== "string" || content.trim().length === 0) {
        return NextResponse.json({ error: "Content cannot be empty" }, { status: 400 });
      }
      updates.content = content.trim();
    }

    // Sharing update - any team member can share/unshare
    if (isShared !== undefined) {
      updates.isShared = isShared;
      if (isShared && !existingComment.isShared) {
        // Sharing for the first time (or re-sharing)
        updates.sharedAt = new Date();
        updates.sharedBy = session.user.id;
      } else if (!isShared) {
        // Unsharing
        updates.sharedAt = null;
        updates.sharedBy = null;
      }
    }

    // Pinning update - any team member can pin/unpin
    if (isPinned !== undefined) {
      updates.isPinned = isPinned;
      if (isPinned) {
        updates.pinnedAt = new Date();
        updates.pinnedBy = session.user.id;
      } else {
        updates.pinnedAt = null;
        updates.pinnedBy = null;
      }
    }

    const [updatedComment] = await db
      .update(taskComments)
      .set(updates)
      .where(eq(taskComments.id, commentId))
      .returning();

    // Fetch with relations
    const fullComment = await db.query.taskComments.findFirst({
      where: eq(taskComments.id, updatedComment.id),
      with: {
        author: {
          columns: { id: true, name: true, email: true, image: true },
        },
        sharedByUser: {
          columns: { id: true, name: true, email: true },
        },
        pinnedByUser: {
          columns: { id: true, name: true, email: true },
        },
      },
    });

    return NextResponse.json(fullComment);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/comments/[commentId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId, commentId } = await params;
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

    const existingComment = await db.query.taskComments.findFirst({
      where: and(
        eq(taskComments.id, commentId),
        eq(taskComments.taskId, taskId)
      ),
    });

    if (!existingComment) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }

    // Only author can delete
    if (existingComment.authorId !== session.user.id) {
      return NextResponse.json(
        { error: "Only the author can delete this comment" },
        { status: 403 }
      );
    }

    await db.delete(taskComments).where(eq(taskComments.id, commentId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
