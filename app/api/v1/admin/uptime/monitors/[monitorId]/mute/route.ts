import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requireAdminAuth } from "@/lib/auth/admin";
import { monitorResponses } from "@/lib/uptime/route-handlers";

type RouteParams = { params: Promise<{ monitorId: string }> };

// POST — mute or unmute an instance monitor's alerts
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    const { monitorId } = await params;
    return await monitorResponses.mute({ kind: "instance" }, monitorId, request);
  } catch (error) {
    return handleRouteError(error, "Error muting instance monitor");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-uptime-mute" });
