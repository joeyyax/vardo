import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireSession } from "@/lib/auth/session";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { readPowerGate } from "@/lib/power/gate";

/** GET /api/v1/system/power — whether the host is on battery and which policies hold work, for any signed-in user */
async function handleGet() {
  try {
    await requireSession();
    const gate = await readPowerGate();
    return NextResponse.json({ onBattery: gate.onBattery, skipBackups: gate.skipBackups, holdDeploys: gate.holdDeploys });
  } catch (error) {
    return handleRouteError(error, "Error reading power state");
  }
}

export const GET = withRateLimit(handleGet, { tier: "poll", key: "get:v1/system/power" });
