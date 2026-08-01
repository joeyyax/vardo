import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import {
  queryOrgBusinessMetric,
  getLatestOrgBusinessMetric,
  type BusinessMetricName,
} from "@/lib/metrics/store";
import { verifyOrgAccess } from "@/lib/api/verify-access";
type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// Metrics with a per-org series.
const VALID_METRICS: BusinessMetricName[] = [
  "users",
  "projects",
  "apps",
  "deployments",
  "domains",
  "backups",
  "cronJobs",
];

// GET /api/v1/organizations/[orgId]/stats/business
// Query params:
//   metrics: comma-separated metric names (default: all)
//   from/to: time range in ms (omit for latest values only)
//   bucket: aggregation bucket in ms (default: 300000 = 5min)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const searchParams = request.nextUrl.searchParams;
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const bucket = parseInt(searchParams.get("bucket") || "300000");
    const requestedMetrics = searchParams.get("metrics")?.split(",") as BusinessMetricName[] | undefined;

    const metrics = requestedMetrics?.filter((m) => VALID_METRICS.includes(m)) ?? VALID_METRICS;

    // Historical query
    if (from && to) {
      const fromMs = parseInt(from);
      const toMs = parseInt(to);

      const results = await Promise.all(
        metrics.map(async (metric) => ({
          metric,
          data: await queryOrgBusinessMetric(orgId, metric, fromMs, toMs, bucket),
        }))
      );

      return NextResponse.json({
        metrics: Object.fromEntries(results.map((r) => [r.metric, r.data])),
      });
    }

    // Latest values
    const results = await Promise.all(
      metrics.map(async (metric) => ({
        metric,
        ...(await getLatestOrgBusinessMetric(orgId, metric)),
      }))
    );

    return NextResponse.json({
      metrics: Object.fromEntries(
        results.map((r) => [r.metric, { value: r.value ?? 0, timestamp: r.timestamp ?? null }])
      ),
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching business metrics");
  }
}
