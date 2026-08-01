import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { eq, and, desc, gte } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { classifyAll } from "@/lib/activity/taxonomy";
import {
  applyFilters,
  parseFamilies,
  parseOutcomes,
  parseSince,
} from "@/lib/activity/filter";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

/**
 * Rows read before narrowing. Family and outcome come from the action string
 * rather than a column, so they cannot be pushed into the query.
 */
const SCAN_LIMIT = 2000;

// GET /api/v1/organizations/[orgId]/activities
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const searchParams = request.nextUrl.searchParams;
    const appId = searchParams.get("appId");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const offset = Math.max(parseInt(searchParams.get("offset") || "0"), 0);

    const filters = {
      families: parseFamilies(searchParams.get("family")),
      outcomes: parseOutcomes(searchParams.get("outcome")),
      since: parseSince(searchParams.get("since")),
    };

    const conditions = [eq(activities.organizationId, orgId)];
    if (appId) conditions.push(eq(activities.appId, appId));
    if (filters.since) {
      conditions.push(gte(activities.createdAt, filters.since));
    }

    const rows = await db.query.activities.findMany({
      where: and(...conditions),
      with: {
        user: { columns: { id: true, name: true, email: true, image: true } },
        app: { columns: { id: true, name: true, displayName: true } },
      },
      orderBy: [desc(activities.createdAt)],
      limit: SCAN_LIMIT,
    });

    const matched = applyFilters(classifyAll(rows), filters);
    const page = matched.slice(offset, offset + limit);

    return NextResponse.json({
      activities: page.map(({ id, action, metadata, createdAt, user, app }) => ({
        id,
        action,
        metadata,
        createdAt,
        user,
        app,
      })),
      pagination: {
        total: matched.length,
        limit,
        offset,
        hasMore: offset + page.length < matched.length,
        /** True when older rows exist beyond the scan cap. */
        truncated: rows.length === SCAN_LIMIT,
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching activities");
  }
}
