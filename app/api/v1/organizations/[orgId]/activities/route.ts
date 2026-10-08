import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { and, desc } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requirePlugin } from "@/lib/api/require-plugin";
import {
  parseFamilies,
  parseOutcomes,
  parseSince,
} from "@/lib/activity/filter";
import { activityConditions, countActivities } from "@/lib/activity/query";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/activities
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

    const gate = await requirePlugin("activity");
    if (gate) return gate;

    const searchParams = request.nextUrl.searchParams;
    const appId = searchParams.get("appId");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const offset = Math.max(parseInt(searchParams.get("offset") || "0"), 0);

    const filters = {
      families: parseFamilies(searchParams.get("family")),
      outcomes: parseOutcomes(searchParams.get("outcome")),
      since: parseSince(searchParams.get("since")),
    };

    const scope = { orgId, appId };

    const [rows, total] = await Promise.all([
      db.query.activities.findMany({
        where: and(...activityConditions(scope, filters)),
        with: {
          user: { columns: { id: true, name: true, email: true, image: true } },
          app: { columns: { id: true, name: true, displayName: true } },
        },
        orderBy: [desc(activities.createdAt)],
        limit,
        offset,
      }),
      countActivities(scope, filters),
    ]);

    return NextResponse.json({
      activities: rows.map(
        ({ id, action, family, outcome, metadata, createdAt, user, app }) => ({
          id,
          action,
          family,
          outcome,
          metadata,
          createdAt,
          user,
          app,
        })
      ),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching activities");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/activities" });
