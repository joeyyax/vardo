import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { actorForOrg } from "@/lib/app-services/session-actor";
import { listActivities } from "@/lib/app-services/activity";
import {
  parseFamilies,
  parseOutcomes,
  parseSince,
} from "@/lib/activity/filter";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/activities
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const actor = await actorForOrg(orgId);
    if (!actor) return apiError.forbidden();

    const searchParams = request.nextUrl.searchParams;
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const offset = Math.max(parseInt(searchParams.get("offset") || "0"), 0);

    const filters = {
      families: parseFamilies(searchParams.get("family")),
      outcomes: parseOutcomes(searchParams.get("outcome")),
      since: parseSince(searchParams.get("since")),
    };

    const { activities, total } = await listActivities(actor, {
      filters,
      appId: searchParams.get("appId"),
      limit,
      offset,
    });

    return NextResponse.json({
      activities,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + activities.length < total,
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching activities");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/activities" });
