import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { inboxItems } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, sql } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/inbox/count
// Returns the count of items needing review (for sidebar badge)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.organizationId, orgId),
          eq(inboxItems.status, "needs_review")
        )
      );

    return NextResponse.json({ count: result?.count ?? 0 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching inbox count:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
