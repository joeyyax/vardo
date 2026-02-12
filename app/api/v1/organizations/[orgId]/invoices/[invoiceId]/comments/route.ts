import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { invoiceComments, invoices, invoiceWatchers, users } from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and, desc, ne } from "drizzle-orm";
import { logCommentAdded } from "@/lib/activities";

type RouteParams = {
  params: Promise<{ orgId: string; invoiceId: string }>;
};

// Auto-add commenter as watcher
async function ensureWatcher(invoiceId: string, userId: string, reason: string) {
  const existing = await db.query.invoiceWatchers.findFirst({
    where: and(
      eq(invoiceWatchers.invoiceId, invoiceId),
      eq(invoiceWatchers.userId, userId)
    ),
  });

  if (!existing) {
    await db.insert(invoiceWatchers).values({
      invoiceId,
      userId,
      reason,
    });
  }
}

// Notify watchers
async function notifyInvoiceWatchers(params: {
  invoiceId: string;
  actorId: string;
  actorName: string;
  isShared: boolean;
}) {
  const { invoiceId, actorId } = params;

  try {
    const watchers = await db.query.invoiceWatchers.findMany({
      where: and(
        eq(invoiceWatchers.invoiceId, invoiceId),
        ne(invoiceWatchers.userId, actorId)
      ),
    });

    // TODO: Create notifications for watchers when notification system is extended
    return [];
  } catch (error) {
    console.error("Error notifying invoice watchers:", error);
    return [];
  }
}

async function verifyInvoiceBelongsToOrg(invoiceId: string, orgId: string) {
  const invoice = await db.query.invoices.findFirst({
    where: and(
      eq(invoices.id, invoiceId),
      eq(invoices.organizationId, orgId)
    ),
  });
  return invoice;
}

// GET /api/v1/organizations/[orgId]/invoices/[invoiceId]/comments
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const invoice = await verifyInvoiceBelongsToOrg(invoiceId, orgId);
    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    const comments = await db.query.invoiceComments.findMany({
      where: eq(invoiceComments.invoiceId, invoiceId),
      orderBy: [desc(invoiceComments.createdAt)],
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
    console.error("Error fetching invoice comments:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/invoices/[invoiceId]/comments
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const invoice = await verifyInvoiceBelongsToOrg(invoiceId, orgId);
    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    const body = await request.json();
    const { content, isShared } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    const [comment] = await db
      .insert(invoiceComments)
      .values({
        invoiceId,
        authorId: session.user.id,
        content: content.trim(),
        isShared: isShared ?? false,
        sharedAt: isShared ? new Date() : null,
        sharedBy: isShared ? session.user.id : null,
      })
      .returning();

    // Auto-watch on comment
    await ensureWatcher(invoiceId, session.user.id, "commenter");

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

    await notifyInvoiceWatchers({
      invoiceId,
      actorId: session.user.id,
      actorName,
      isShared: comment.isShared ?? false,
    });

    // Fetch the comment with author info
    const commentWithAuthor = await db.query.invoiceComments.findFirst({
      where: eq(invoiceComments.id, comment.id),
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
    console.error("Error creating invoice comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
