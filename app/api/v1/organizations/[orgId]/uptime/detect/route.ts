import { NextRequest } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { monitorResponses } from "@/lib/uptime/route-handlers";

type RouteParams = { params: Promise<{ orgId: string }> };

// POST — look for a health endpoint at a URL, without saving anything
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    if (!(await verifyOrgAccess(orgId, "uptime.manage"))) return apiError.forbidden();
    return await monitorResponses.detect({ kind: "org", orgId }, request);
  } catch (error) {
    return handleRouteError(error, "Error detecting a health endpoint");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-uptime-detect" });
