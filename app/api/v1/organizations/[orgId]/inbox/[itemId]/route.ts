import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { inboxItems, INBOX_ITEM_STATUSES, type InboxItemStatus } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; itemId: string }>;
};

// GET /api/v1/organizations/[orgId]/inbox/[itemId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const item = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.organizationId, orgId)
      ),
      with: {
        files: true,
        convertedExpense: {
          columns: {
            id: true,
            description: true,
            amountCents: true,
            date: true,
          },
        },
      },
    });

    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching inbox item:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/organizations/[orgId]/inbox/[itemId]
// Update status (discard, mark informational)
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { status } = body;

    if (!status || !INBOX_ITEM_STATUSES.includes(status as InboxItemStatus)) {
      return NextResponse.json(
        { error: "Invalid status. Must be one of: " + INBOX_ITEM_STATUSES.join(", ") },
        { status: 400 }
      );
    }

    // Verify item exists and belongs to this org
    const existing = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [updated] = await db
      .update(inboxItems)
      .set({ status: status as InboxItemStatus, updatedAt: new Date() })
      .where(eq(inboxItems.id, itemId))
      .returning();

    return NextResponse.json({ item: updated });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error updating inbox item:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
