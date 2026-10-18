import { NextRequest, NextResponse } from "next/server";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { readAppDrill } from "@/lib/admin-apps/read";

type RouteParams = { params: Promise<{ appId: string }> };

// GET /api/v1/admin/apps/[appId]
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    await requireAppAdmin();
    const { appId } = await params;
    const drill = await readAppDrill(appId);
    if (!drill) return apiError.notFound("app");
    return NextResponse.json(drill);
  } catch (error) {
    return handleRouteError(error, "Error reading the app");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/apps/*" });
