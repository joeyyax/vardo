import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { getAppUptime } from "@/lib/uptime/service";

type RouteParams = { params: Promise<{ orgId: string; appId: string }> };

/** GET — an app's uptime: its monitors, uptime over 24 hours, 30 and 90 days, and its last outage. */
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "uptime.view");
    if (!app) return apiError.notFound("app");
    return NextResponse.json(await getAppUptime(orgId, appId));
  } catch (error) {
    return handleRouteError(error, "Error reading app uptime");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/uptime/apps" });
