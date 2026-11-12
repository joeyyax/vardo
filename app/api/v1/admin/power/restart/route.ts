import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { restartStoppedByHand } from "@/lib/power/stops";

/** POST /api/v1/admin/power/restart — restart every app still stopped for power */
async function handlePost() {
  try {
    await requireAppAdmin();
    const restarted = await restartStoppedByHand();
    return NextResponse.json({ restarted });
  } catch (error) {
    return handleRouteError(error, "Error restarting apps stopped for power");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-power-restart" });
