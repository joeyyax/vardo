import { NextRequest, NextResponse } from "next/server";
import { getAlertState } from "@/lib/system-alerts/state";
import { requireAdminAuth } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";

// GET /api/v1/system/alerts — platform-level, returns current alert state
export async function GET(request: NextRequest) {
  try {
    await requireAdminAuth(request);

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
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error fetching system alerts");
  }
}
