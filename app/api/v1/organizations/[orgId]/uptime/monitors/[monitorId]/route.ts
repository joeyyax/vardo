import { parseRange } from "@/lib/uptime/core";
import { NextRequest } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { monitorResponses } from "@/lib/uptime/route-handlers";

const rangeOf = (request: NextRequest) => parseRange(new URL(request.url).searchParams.get("range"));

type RouteParams = { params: Promise<{ orgId: string; monitorId: string }> };

// GET — one monitor: 24h, 30d and 90d uptime, 90 daily buckets, latency per vantage point, outages
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, monitorId } = await params;
    if (!(await verifyOrgAccess(orgId, "org.view"))) return apiError.forbidden();
    return await monitorResponses.get({ kind: "org", orgId }, monitorId, rangeOf(request));
  } catch (error) {
    return handleRouteError(error, "Error reading monitor");
  }
}

// PATCH — change a monitor. Automatic ones only turn off, mute or go into maintenance.
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, monitorId } = await params;
    if (!(await verifyOrgAccess(orgId, "uptime.manage"))) return apiError.forbidden();
    return await monitorResponses.update({ kind: "org", orgId }, monitorId, request);
  } catch (error) {
    return handleRouteError(error, "Error updating monitor");
  }
}

// DELETE — remove a manual monitor
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, monitorId } = await params;
    if (!(await verifyOrgAccess(orgId, "uptime.manage"))) return apiError.forbidden();
    return await monitorResponses.remove({ kind: "org", orgId }, monitorId);
  } catch (error) {
    return handleRouteError(error, "Error deleting monitor");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/uptime/monitors/*" });
export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-uptime-monitor" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-uptime-monitor" });
