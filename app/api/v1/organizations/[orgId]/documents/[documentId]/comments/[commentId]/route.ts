import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documentComments, documents } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; documentId: string; commentId: string }>;
};

async function verifyDocumentBelongsToOrg(documentId: string, orgId: string) {
  const document = await db.query.documents.findFirst({
    where: and(
      eq(documents.id, documentId),
      eq(documents.organizationId, orgId)
    ),
  });
  return document;
}

// PATCH /api/v1/organizations/[orgId]/documents/[documentId]/comments/[commentId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, documentId, commentId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const document = await verifyDocumentBelongsToOrg(documentId, orgId);
    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const existingComment = await db.query.documentComments.findFirst({
      where: and(
        eq(documentComments.id, commentId),
        eq(documentComments.documentId, documentId)
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
      if (typeof content !== "string" || !content.trim()) {
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
      .update(documentComments)
      .set(updates)
      .where(eq(documentComments.id, commentId))
      .returning();

    // Fetch with relations
    const fullComment = await db.query.documentComments.findFirst({
      where: eq(documentComments.id, updatedComment.id),
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
    console.error("Error updating document comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/documents/[documentId]/comments/[commentId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, documentId, commentId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const document = await verifyDocumentBelongsToOrg(documentId, orgId);
    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const existingComment = await db.query.documentComments.findFirst({
      where: and(
        eq(documentComments.id, commentId),
        eq(documentComments.documentId, documentId)
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

    await db.delete(documentComments).where(eq(documentComments.id, commentId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting document comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
