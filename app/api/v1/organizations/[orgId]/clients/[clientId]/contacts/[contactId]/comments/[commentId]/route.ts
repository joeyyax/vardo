import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { contactComments, clientContacts, clients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{
    orgId: string;
    clientId: string;
    contactId: string;
    commentId: string;
  }>;
};

async function verifyContactBelongsToClient(
  contactId: string,
  clientId: string,
  orgId: string
) {
  const client = await db.query.clients.findFirst({
    where: and(eq(clients.id, clientId), eq(clients.organizationId, orgId)),
  });
  if (!client) return null;

  const contact = await db.query.clientContacts.findFirst({
    where: and(
      eq(clientContacts.id, contactId),
      eq(clientContacts.clientId, clientId)
    ),
  });
  return contact;
}

// PATCH /api/v1/organizations/[orgId]/clients/[clientId]/contacts/[contactId]/comments/[commentId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId, contactId, commentId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const contact = await verifyContactBelongsToClient(
      contactId,
      clientId,
      orgId
    );
    if (!contact) {
      return NextResponse.json(
        { error: "Contact not found" },
        { status: 404 }
      );
    }

    const existingComment = await db.query.contactComments.findFirst({
      where: and(
        eq(contactComments.id, commentId),
        eq(contactComments.contactId, contactId)
      ),
    });

    if (!existingComment) {
      return NextResponse.json(
        { error: "Comment not found" },
        { status: 404 }
      );
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
        return NextResponse.json(
          { error: "Content cannot be empty" },
          { status: 400 }
        );
      }
      updates.content = content.trim();
    }

    // Sharing update - any team member can share/unshare
    if (isShared !== undefined) {
      updates.isShared = isShared;
      if (isShared && !existingComment.isShared) {
        updates.sharedAt = new Date();
        updates.sharedBy = session.user.id;
      } else if (!isShared) {
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
      .update(contactComments)
      .set(updates)
      .where(eq(contactComments.id, commentId))
      .returning();

    // Fetch with relations
    const fullComment = await db.query.contactComments.findFirst({
      where: eq(contactComments.id, updatedComment.id),
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
    console.error("Error updating contact comment:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/organizations/[orgId]/clients/[clientId]/contacts/[contactId]/comments/[commentId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId, contactId, commentId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const contact = await verifyContactBelongsToClient(
      contactId,
      clientId,
      orgId
    );
    if (!contact) {
      return NextResponse.json(
        { error: "Contact not found" },
        { status: 404 }
      );
    }

    const existingComment = await db.query.contactComments.findFirst({
      where: and(
        eq(contactComments.id, commentId),
        eq(contactComments.contactId, contactId)
      ),
    });

    if (!existingComment) {
      return NextResponse.json(
        { error: "Comment not found" },
        { status: 404 }
      );
    }

    // Only author can delete
    if (existingComment.authorId !== session.user.id) {
      return NextResponse.json(
        { error: "Only the author can delete this comment" },
        { status: 403 }
      );
    }

    await db
      .delete(contactComments)
      .where(eq(contactComments.id, commentId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting contact comment:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
