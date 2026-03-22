import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { getSystemHealth } from "@/lib/config/health";
import { getAllFeatureFlags } from "@/lib/config/features";

// GET /api/v1/admin/health
export async function GET() {
  try {
    await requireAppAdmin();

    const [health, featureFlags] = await Promise.all([
      getSystemHealth(),
      Promise.resolve(getAllFeatureFlags()),
    ]);

    return NextResponse.json({
      ...health,
      featureFlags,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error fetching system health");
  }
}
