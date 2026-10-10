import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { getSystemHealth } from "@/lib/config/health";
import { getAllFeatureFlags } from "@/lib/config/features";

// GET /api/v1/admin/health
async function handleGet() {
  try {
    await requireAppAdmin();

    const [health, featureFlags] = await Promise.all([
      getSystemHealth(),
      getAllFeatureFlags(),
    ]);

    return NextResponse.json({
      ...health,
      featureFlags,
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching system health");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/health" });
