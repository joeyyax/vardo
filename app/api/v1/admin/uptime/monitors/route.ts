import { parseRange } from "@/lib/uptime/core";
import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requireAdminAuth } from "@/lib/auth/admin";
import { monitorResponses } from "@/lib/uptime/route-handlers";

const rangeOf = (request: NextRequest) => parseRange(new URL(request.url).searchParams.get("range"));

// GET — the instance's monitors
async function handleGet(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    return await monitorResponses.list({ kind: "instance" }, rangeOf(request));
  } catch (error) {
    return handleRouteError(error, "Error listing instance monitors");
  }
}

// POST — add an instance monitor
async function handlePost(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    return await monitorResponses.create({ kind: "instance" }, request);
  } catch (error) {
    return handleRouteError(error, "Error creating instance monitor");
  }
}

export const GET = withRateLimit(handleGet, { tier: "admin", key: "get:v1/admin/uptime/monitors" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-uptime-monitors" });
