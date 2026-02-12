import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  contactComments,
  contactWatchers,
  clientContacts,
  clients,
  users,
} from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc, ne } from "drizzle-orm";
import { logActivity } from "@/lib/activities";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string; contactId: string }>;
};

async function ensureWatcher(
  contactId: string,
  userId: string,
  reason: string
) {
  const existing = await db.query.contactWatchers.findFirst({
    where: and(
      eq(contactWatchers.contactId, contactId),
      eq(contactWatchers.userId, userId)
    ),
  });

  if (!existing) {
    await db.insert(contactWatchers).values({
      contactId,
      userId,
      reason,
    });
  }
}

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

// GET /api/v1/organizations/[orgId]/clients/[clientId]/contacts/[contactId]/comments
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId, contactId } = await params;
    const { organization } = await requireOrg();

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

    const comments = await db.query.contactComments.findMany({
      where: eq(contactComments.contactId, contactId),
      orderBy: [desc(contactComments.createdAt)],
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
    console.error("Error fetching contact comments:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/clients/[clientId]/contacts/[contactId]/comments
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId, contactId } = await params;
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

    const body = await request.json();
    const { content, isShared } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json(
        { error: "Content is required" },
        { status: 400 }
      );
    }

    const [comment] = await db
      .insert(contactComments)
      .values({
        contactId,
        authorId: session.user.id,
        content: content.trim(),
        isShared: isShared ?? false,
        sharedAt: isShared ? new Date() : null,
        sharedBy: isShared ? session.user.id : null,
      })
      .returning();

    // Auto-watch on comment
    await ensureWatcher(contactId, session.user.id, "commenter");

    // Log activity
    await logActivity({
      organizationId: orgId,
      actorId: session.user.id,
      action: "commented",
      entityType: "contact",
      entityId: contactId,
      metadata: {
        commentId: comment.id,
        isShared: comment.isShared,
      },
      isClientVisible: (comment.isShared ?? false) && true,
    });

    // Fetch the comment with author info
    const commentWithAuthor = await db.query.contactComments.findFirst({
      where: eq(contactComments.id, comment.id),
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
    console.error("Error creating contact comment:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
