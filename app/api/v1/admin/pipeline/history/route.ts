import { NextRequest, NextResponse } from "next/server";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { HISTORY_WINDOWS, readPipelineHistory, type HistoryWindow } from "@/lib/pipeline/read";

// GET /api/v1/admin/pipeline/history?window=1h|6h
// Deploys finished in the window, for the Deploys card's longer views.
async function handleGet(request: NextRequest) {
  try {
    await requireAppAdmin();
    const window = request.nextUrl.searchParams.get("window") ?? "";
    if (!(window in HISTORY_WINDOWS)) return NextResponse.json({ error: "Window must be 1h or 6h." }, { status: 400 });
    return NextResponse.json(await readPipelineHistory(window as HistoryWindow));
  } catch (error) {
    return handleRouteError(error, "Error reading pipeline history");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/pipeline/history" });
