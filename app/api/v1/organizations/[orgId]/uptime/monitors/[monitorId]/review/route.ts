import { NextRequest } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { monitorResponses } from "@/lib/uptime/route-handlers";

type RouteParams = { params: Promise<{ orgId: string; monitorId: string }> };

// POST — answer what should count as up for a monitor that needs review
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, monitorId } = await params;
    if (!(await verifyOrgAccess(orgId, "uptime.manage"))) return apiError.forbidden();
    return await monitorResponses.review({ kind: "org", orgId }, monitorId, request);
  } catch (error) {
    return handleRouteError(error, "Error answering the review");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-uptime-review" });
