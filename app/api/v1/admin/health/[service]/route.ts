import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { checkServiceByName } from "@/lib/config/health";
import { withRateLimit } from "@/lib/api/with-rate-limit";

// POST /api/v1/admin/health/[service] — re-probe one service on demand
async function handlePost(
  _request: NextRequest,
  { params }: { params: Promise<{ service: string }> },
) {
  try {
    await requireAppAdmin();

    const { service } = await params;
    const status = await checkServiceByName(decodeURIComponent(service));
    if (!status) {
      return NextResponse.json({ error: "Unknown service" }, { status: 404 });
    }

    return NextResponse.json({ service: status });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error checking service health");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-health-check" });
