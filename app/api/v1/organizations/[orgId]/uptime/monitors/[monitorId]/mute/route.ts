import { NextRequest } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { monitorResponses } from "@/lib/uptime/route-handlers";

type RouteParams = { params: Promise<{ orgId: string; monitorId: string }> };

// POST — mute or unmute a monitor's alerts. Downtime still counts toward uptime.
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, monitorId } = await params;
    if (!(await verifyOrgAccess(orgId, "uptime.manage"))) return apiError.forbidden();
    return await monitorResponses.mute({ kind: "org", orgId }, monitorId, request);
  } catch (error) {
    return handleRouteError(error, "Error muting monitor");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-uptime-mute" });
