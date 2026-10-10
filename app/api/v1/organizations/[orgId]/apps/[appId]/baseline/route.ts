import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { BASELINE_WINDOW_MS, computeBaseline, highMark, isWarm, statsAt, zoneOffset } from "@/lib/anomaly/baseline";
import { readSamples } from "@/lib/anomaly/store";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { getInstanceTimeZone, resolveTimeZone } from "@/lib/time-zone-settings";

type RouteParams = { params: Promise<{ orgId: string; appId: string }> };

const HOUR = 60 * 60_000;
/** A week of hourly bands at most. */
const MAX_HOURS = 24 * 7;

// GET /api/v1/organizations/[orgId]/apps/[appId]/baseline?from=&to= — hourly normal CPU range, empty while warming up.
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.view");
    if (!org) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
      with: { organization: { columns: { timeZone: true } } },
    });
    if (!app) return apiError.notFound("app");

    const now = Date.now();
    const to = Math.min(Number(request.nextUrl.searchParams.get("to")) || now, now);
    const from = Math.max(Number(request.nextUrl.searchParams.get("from")) || to - HOUR, to - MAX_HOURS * HOUR);

    const baseline = computeBaseline(await readSamples(appId, "cpu", now - BASELINE_WINDOW_MS, now), now);
    if (!isWarm(baseline, now)) return NextResponse.json({ cpu: [] });

    const offset = zoneOffset(resolveTimeZone(app.organization?.timeZone, await getInstanceTimeZone()));
    const bands: { at: number; typical: number; high: number }[] = [];
    for (let at = Math.floor(from / HOUR) * HOUR; at <= to; at += HOUR) {
      const stats = statsAt(baseline, at + HOUR / 2, offset);
      if (stats) bands.push({ at, typical: stats.median, high: highMark(stats) });
    }
    return NextResponse.json({ cpu: bands });
  } catch (error) {
    return handleRouteError(error, "Error fetching baseline");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*/baseline" });
