import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { inboxItems, INBOX_ITEM_STATUSES, type InboxItemStatus } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/inbox
// List inbox items with files
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");

    const whereConditions = [eq(inboxItems.organizationId, orgId)];

    if (status && INBOX_ITEM_STATUSES.includes(status as InboxItemStatus)) {
      whereConditions.push(eq(inboxItems.status, status as InboxItemStatus));
    }

    const items = await db.query.inboxItems.findMany({
      where: and(...whereConditions),
      orderBy: [desc(inboxItems.receivedAt)],
      with: {
        files: true,
        convertedExpense: {
          columns: {
            id: true,
            description: true,
            amountCents: true,
          },
        },
        client: {
          columns: { id: true, name: true },
        },
        project: {
          columns: { id: true, name: true },
        },
      },
    });

    // Count of needs_review items (for badge)
    const needsReviewCount = items.filter(
      (i) => i.status === "needs_review"
    ).length;

    return NextResponse.json({ items, needsReviewCount });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching inbox items:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
