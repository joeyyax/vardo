import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/activities
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const searchParams = request.nextUrl.searchParams;
    const appId = searchParams.get("appId");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const offset = parseInt(searchParams.get("offset") || "0");

    // Build conditions
    const conditions = [eq(activities.organizationId, orgId)];

    if (appId) {
      conditions.push(eq(activities.appId, appId));
    }

    const activityList = await db.query.activities.findMany({
      where: and(...conditions),
      with: {
        user: {
          columns: { id: true, name: true, email: true, image: true },
        },
        app: {
          columns: { id: true, name: true },
        },
      },
      orderBy: [desc(activities.createdAt)],
      limit,
      offset,
    });

    // Get total count for pagination
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(activities)
      .where(and(...conditions));

    return NextResponse.json({
      activities: activityList,
      pagination: {
        total: Number(count),
        limit,
        offset,
        hasMore: offset + activityList.length < Number(count),
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching activities");
  }
}
