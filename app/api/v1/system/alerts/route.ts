import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { getAlertState } from "@/lib/system-alerts/state";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";

// GET /api/v1/system/alerts — platform-level, returns current alert state
async function handleGet(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const alerts = getAlertState();

    const active = alerts.filter((a) => {
      // Active means fired in the last 24h.
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
      return apiError.unauthorized();
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return apiError.forbidden();
    }
    return handleRouteError(error, "Error fetching system alerts");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/system/alerts" });
