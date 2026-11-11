import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { BUCKET_MS, RANGE_MS, type TimeRange } from "@/lib/metrics/constants";
import { queryUpsHistory } from "@/lib/ups/history";
import { getUpsServer } from "@/lib/ups/store";

/** GET /api/v1/admin/ups/[serverId]/history?range=6h */
async function handleGet(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  try {
    await requireAppAdmin();
    const row = await getUpsServer((await params).serverId);
    if (!row) return apiError.notFound("UPS server");
    const asked = request.nextUrl.searchParams.get("range") ?? "6h";
    const range: TimeRange = asked in RANGE_MS ? (asked as TimeRange) : "6h";
    const to = Date.now();
    const points = await queryUpsHistory(row.id, to - RANGE_MS[range], to, Math.max(BUCKET_MS[range], 15_000));
    return NextResponse.json({ range, points });
  } catch (error) {
    return handleRouteError(error, "Error reading UPS history");
  }
}

export const GET = withRateLimit(handleGet, { tier: "poll", key: "get:v1/admin/ups/*/history" });
