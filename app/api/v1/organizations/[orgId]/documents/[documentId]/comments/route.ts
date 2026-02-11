import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documentComments, documents, documentWatchers, users } from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and, desc, ne } from "drizzle-orm";
import { logCommentAdded } from "@/lib/activities";

type RouteParams = {
  params: Promise<{ orgId: string; documentId: string }>;
};

// Auto-add commenter as watcher
async function ensureWatcher(documentId: string, userId: string, reason: string) {
  const existing = await db.query.documentWatchers.findFirst({
    where: and(
      eq(documentWatchers.documentId, documentId),
      eq(documentWatchers.userId, userId)
    ),
  });

  if (!existing) {
    await db.insert(documentWatchers).values({
      documentId,
      userId,
      reason,
    });
  }
}

// Notify watchers
async function notifyDocumentWatchers(params: {
  documentId: string;
  actorId: string;
  actorName: string;
  isShared: boolean;
}) {
  const { documentId, actorId } = params;

  try {
    const watchers = await db.query.documentWatchers.findMany({
      where: and(
        eq(documentWatchers.documentId, documentId),
        ne(documentWatchers.userId, actorId)
      ),
    });

    // TODO: Create notifications for watchers when notification system is extended
    return [];
  } catch (error) {
    console.error("Error notifying document watchers:", error);
    return [];
  }
}

async function verifyDocumentBelongsToOrg(documentId: string, orgId: string) {
  const document = await db.query.documents.findFirst({
    where: and(
      eq(documents.id, documentId),
      eq(documents.organizationId, orgId)
    ),
  });
  return document;
}

// GET /api/v1/organizations/[orgId]/documents/[documentId]/comments
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, documentId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const document = await verifyDocumentBelongsToOrg(documentId, orgId);
    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const comments = await db.query.documentComments.findMany({
      where: eq(documentComments.documentId, documentId),
      orderBy: [desc(documentComments.createdAt)],
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
    console.error("Error fetching document comments:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/documents/[documentId]/comments
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, documentId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const document = await verifyDocumentBelongsToOrg(documentId, orgId);
    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const body = await request.json();
    const { content, isShared } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    const [comment] = await db
      .insert(documentComments)
      .values({
        documentId,
        authorId: session.user.id,
        content: content.trim(),
        isShared: isShared ?? false,
        sharedAt: isShared ? new Date() : null,
        sharedBy: isShared ? session.user.id : null,
      })
      .returning();

    // Auto-watch on comment
    await ensureWatcher(documentId, session.user.id, "commenter");

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

    await notifyDocumentWatchers({
      documentId,
      actorId: session.user.id,
      actorName,
      isShared: comment.isShared ?? false,
    });

    // Fetch the comment with author info
    const commentWithAuthor = await db.query.documentComments.findFirst({
      where: eq(documentComments.id, comment.id),
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
    console.error("Error creating document comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
