import { NextRequest, NextResponse } from "next/server";
import { getSystemHealth } from "@/lib/config/health";
import { requireAdminAuth } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";

// GET /api/health/system — full system health for the dashboard UI
export async function GET(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const health = await getSystemHealth();
    return NextResponse.json(health);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error fetching system health");
  }
}
