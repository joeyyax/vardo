import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requireAdminAuth } from "@/lib/auth/admin";
import { monitorResponses } from "@/lib/uptime/route-handlers";

type RouteParams = { params: Promise<{ monitorId: string }> };

// GET — one instance monitor
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    const { monitorId } = await params;
    return await monitorResponses.get({ kind: "instance" }, monitorId);
  } catch (error) {
    return handleRouteError(error, "Error reading instance monitor");
  }
}

// PATCH — change an instance monitor
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    const { monitorId } = await params;
    return await monitorResponses.update({ kind: "instance" }, monitorId, request);
  } catch (error) {
    return handleRouteError(error, "Error updating instance monitor");
  }
}

// DELETE — remove a manual instance monitor
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    const { monitorId } = await params;
    return await monitorResponses.remove({ kind: "instance" }, monitorId);
  } catch (error) {
    return handleRouteError(error, "Error deleting instance monitor");
  }
}

export const GET = withRateLimit(handleGet, { tier: "admin", key: "get:v1/admin/uptime/monitors/*" });
export const PATCH = withRateLimit(handlePatch, { tier: "admin", key: "admin-uptime-monitor" });
export const DELETE = withRateLimit(handleDelete, { tier: "admin", key: "admin-uptime-monitor" });
