import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { restoreStatus, RESTORE_COOKIE } from "@/lib/restore/status";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";

// GET /api/setup/restore — where a whole-instance restore stands.
async function handler(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  try {
    return NextResponse.json(await restoreStatus(request.cookies.get(RESTORE_COOKIE)?.value));
  } catch (error) {
    return handleRouteError(error, "Error reading restore status");
  }
}

export const GET = withRateLimit(handler, { tier: "read", key: "setup-restore" });
