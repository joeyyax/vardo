import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { getSystemHealth } from "@/lib/config/health";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";

// GET /api/health/system — full system health for the dashboard UI
async function handleGet(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const health = await getSystemHealth();
    return NextResponse.json(health);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiError.unauthorized();
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return apiError.forbidden();
    }
    return handleRouteError(error, "Error fetching system health");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:health/system" });
