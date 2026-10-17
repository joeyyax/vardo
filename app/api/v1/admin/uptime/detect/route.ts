import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requireAdminAuth } from "@/lib/auth/admin";
import { monitorResponses } from "@/lib/uptime/route-handlers";

// POST — look for a health endpoint at a URL, without saving anything
async function handlePost(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    return await monitorResponses.detect({ kind: "instance" }, request);
  } catch (error) {
    return handleRouteError(error, "Error detecting a health endpoint");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-uptime-detect" });
