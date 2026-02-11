import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectComments, projects, projectWatchers, users } from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and, desc, ne } from "drizzle-orm";
import { logCommentAdded } from "@/lib/activities";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// Auto-add commenter as watcher
async function ensureWatcher(projectId: string, userId: string, reason: string) {
  const existing = await db.query.projectWatchers.findFirst({
    where: and(
      eq(projectWatchers.projectId, projectId),
      eq(projectWatchers.userId, userId)
    ),
  });

  if (!existing) {
    await db.insert(projectWatchers).values({
      projectId,
      userId,
      reason,
    });
  }
}

// Notify watchers
async function notifyProjectWatchers(params: {
  projectId: string;
  actorId: string;
  actorName: string;
  isShared: boolean;
}) {
  const { projectId, actorId, actorName, isShared } = params;

  try {
    const watchers = await db.query.projectWatchers.findMany({
      where: and(
        eq(projectWatchers.projectId, projectId),
        ne(projectWatchers.userId, actorId)
      ),
    });

    const content = `${actorName} commented on a project`;
    // TODO: Create notifications for watchers when notification system is extended
    // For now, just log the action
    return [];
  } catch (error) {
    console.error("Error notifying project watchers:", error);
    return [];
  }
}

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

// GET /api/v1/organizations/[orgId]/projects/[projectId]/comments
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const comments = await db.query.projectComments.findMany({
      where: eq(projectComments.projectId, projectId),
      orderBy: [desc(projectComments.createdAt)],
      with: {
        author: {
          columns: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        sharedByUser: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return NextResponse.json(comments);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching project comments:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/comments
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const { content, isShared } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    const [comment] = await db
      .insert(projectComments)
      .values({
        projectId,
        authorId: session.user.id,
        content: content.trim(),
        isShared: isShared ?? false,
        sharedAt: isShared ? new Date() : null,
        sharedBy: isShared ? session.user.id : null,
      })
      .returning();

    // Auto-watch on comment
    await ensureWatcher(projectId, session.user.id, "commenter");

    // Log activity
    await logCommentAdded({
      organizationId: orgId,
      actorId: session.user.id,
      projectId,
      commentId: comment.id,
      isShared: comment.isShared ?? false,
    });

    // Notify watchers
    const actor = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { name: true, email: true },
    });
    const actorName = actor?.name || actor?.email || "Someone";

    await notifyProjectWatchers({
      projectId,
      actorId: session.user.id,
      actorName,
      isShared: comment.isShared ?? false,
    });

    // Fetch the comment with author info
    const commentWithAuthor = await db.query.projectComments.findFirst({
      where: eq(projectComments.id, comment.id),
      with: {
        author: {
          columns: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        sharedByUser: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return NextResponse.json(commentWithAuthor, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating project comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
