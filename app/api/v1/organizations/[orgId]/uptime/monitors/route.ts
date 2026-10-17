import { NextRequest } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { monitorResponses } from "@/lib/uptime/route-handlers";

type RouteParams = { params: Promise<{ orgId: string }> };

// GET — the org's monitors with current state, 30-day uptime and daily buckets
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    if (!(await verifyOrgAccess(orgId, "org.view"))) return apiError.forbidden();
    return await monitorResponses.list({ kind: "org", orgId });
  } catch (error) {
    return handleRouteError(error, "Error listing monitors");
  }
}

// POST — add a monitor
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    if (!(await verifyOrgAccess(orgId, "uptime.manage"))) return apiError.forbidden();
    return await monitorResponses.create({ kind: "org", orgId }, request);
  } catch (error) {
    return handleRouteError(error, "Error creating monitor");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/uptime/monitors" });
export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-uptime-monitors" });
