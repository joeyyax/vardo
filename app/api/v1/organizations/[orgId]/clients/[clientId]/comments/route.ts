import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientComments, clients, clientWatchers, users } from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and, desc, ne } from "drizzle-orm";
import { logCommentAdded } from "@/lib/activities";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string }>;
};

// Auto-add commenter as watcher
async function ensureWatcher(clientId: string, userId: string, reason: string) {
  const existing = await db.query.clientWatchers.findFirst({
    where: and(
      eq(clientWatchers.clientId, clientId),
      eq(clientWatchers.userId, userId)
    ),
  });

  if (!existing) {
    await db.insert(clientWatchers).values({
      clientId,
      userId,
      reason,
    });
  }
}

// Notify watchers
async function notifyClientWatchers(params: {
  clientId: string;
  actorId: string;
  actorName: string;
  isShared: boolean;
}) {
  const { clientId, actorId } = params;

  try {
    const watchers = await db.query.clientWatchers.findMany({
      where: and(
        eq(clientWatchers.clientId, clientId),
        ne(clientWatchers.userId, actorId)
      ),
    });

    // TODO: Create notifications for watchers when notification system is extended
    return [];
  } catch (error) {
    console.error("Error notifying client watchers:", error);
    return [];
  }
}

async function verifyClientBelongsToOrg(clientId: string, orgId: string) {
  const client = await db.query.clients.findFirst({
    where: and(
      eq(clients.id, clientId),
      eq(clients.organizationId, orgId)
    ),
  });
  return client;
}

// GET /api/v1/organizations/[orgId]/clients/[clientId]/comments
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const client = await verifyClientBelongsToOrg(clientId, orgId);
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const comments = await db.query.clientComments.findMany({
      where: eq(clientComments.clientId, clientId),
      orderBy: [desc(clientComments.createdAt)],
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
        pinnedByUser: {
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
    console.error("Error fetching client comments:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/clients/[clientId]/comments
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const client = await verifyClientBelongsToOrg(clientId, orgId);
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const body = await request.json();
    const { content, isShared } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    const [comment] = await db
      .insert(clientComments)
      .values({
        clientId,
        authorId: session.user.id,
        content: content.trim(),
        isShared: isShared ?? false,
        sharedAt: isShared ? new Date() : null,
        sharedBy: isShared ? session.user.id : null,
      })
      .returning();

    // Auto-watch on comment
    await ensureWatcher(clientId, session.user.id, "commenter");

    // Log activity
    await logCommentAdded({
      organizationId: orgId,
      actorId: session.user.id,
      commentId: comment.id,
      isShared: comment.isShared ?? false,
    });

    // Notify watchers
    const actor = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { name: true, email: true },
    });
    const actorName = actor?.name || actor?.email || "Someone";

    await notifyClientWatchers({
      clientId,
      actorId: session.user.id,
      actorName,
      isShared: comment.isShared ?? false,
    });

    // Fetch the comment with author info
    const commentWithAuthor = await db.query.clientComments.findFirst({
      where: eq(clientComments.id, comment.id),
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
        pinnedByUser: {
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
    console.error("Error creating client comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
