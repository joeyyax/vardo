import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { getOrgResources, DEFAULT_WINDOW_MS, DEFAULT_BUCKETS } from "@/lib/metrics/resources-query";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BUCKETS = 120;

function positiveInt(raw: string | null, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

// GET /api/v1/organizations/[orgId]/resources
// Usage and limit for CPU, memory, disk, network and GPU, per app and per project.
// Query params: window (ms of history), buckets (sparkline points)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const search = request.nextUrl.searchParams;
    const resources = await getOrgResources(orgId, {
      windowMs: positiveInt(search.get("window"), DEFAULT_WINDOW_MS, MAX_WINDOW_MS),
      buckets: positiveInt(search.get("buckets"), DEFAULT_BUCKETS, MAX_BUCKETS),
    });

    return NextResponse.json(resources);
  } catch (error) {
    return handleRouteError(error, "Error fetching resource usage");
  }
}
