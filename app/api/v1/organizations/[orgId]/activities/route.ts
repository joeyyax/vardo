import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc, sql } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/activities
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const searchParams = request.nextUrl.searchParams;
    const projectId = searchParams.get("projectId");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const offset = parseInt(searchParams.get("offset") || "0");

    // Build conditions
    const conditions = [eq(activities.organizationId, orgId)];

    if (projectId) {
      conditions.push(eq(activities.projectId, projectId));
    }

    const activityList = await db.query.activities.findMany({
      where: and(...conditions),
      with: {
        user: {
          columns: { id: true, name: true, email: true, image: true },
        },
        project: {
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
