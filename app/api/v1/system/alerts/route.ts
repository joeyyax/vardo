import { NextResponse } from "next/server";
import { getAlertState } from "@/lib/system-alerts/state";

// GET /api/v1/system/alerts — platform-level, returns current alert state
export async function GET() {
  const alerts = getAlertState();

  const active = alerts.filter((a) => {
    // Consider an alert "active" if fired in the last 24h
    const elapsed = Date.now() - a.lastFired.getTime();
    return elapsed < 24 * 60 * 60 * 1000;
  });

  const history = alerts
    .slice()
    .sort((a, b) => b.lastFired.getTime() - a.lastFired.getTime())
    .slice(0, 50);

  return NextResponse.json({
    active,
    history,
    total: alerts.length,
  });
}
