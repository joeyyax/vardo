import { parseRange } from "@/lib/uptime/core";
import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { containerHealthFor } from "@/lib/uptime/health";
import { getAppUptime } from "@/lib/uptime/service";
import { getOrgTimeZone } from "@/lib/time-zone-settings";

const rangeOf = (request: NextRequest) => parseRange(new URL(request.url).searchParams.get("range"));

type RouteParams = { params: Promise<{ orgId: string; appId: string }> };

/** GET — an app's uptime: its monitors, uptime over 24 hours, 30 and 90 days, its last outage and its container healthcheck. */
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.view");
    if (!app) return apiError.notFound("app");
    const [uptime, container, timeZone] = await Promise.all([getAppUptime(orgId, appId, Date.now(), rangeOf(request)), containerHealthFor(orgId, appId), getOrgTimeZone(orgId)]);
    return NextResponse.json({ ...uptime, container, timeZone });
  } catch (error) {
    return handleRouteError(error, "Error reading app uptime");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/uptime/apps" });
