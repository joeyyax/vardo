import { NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { getSystemHealth } from "@/lib/config/health";
import { getAllFeatureFlags } from "@/lib/config/features";

// GET /api/v1/admin/health
export async function GET() {
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
    if (error instanceof Error && error.message === "Forbidden") {
      return apiError.forbidden();
    }
    return handleRouteError(error, "Error fetching system health");
  }
}
