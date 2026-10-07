import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { fetchAllMetrics } from "@/lib/metrics/provider";
import { groupMetricsByApp } from "@/lib/metrics/app-match";
import { METRICS_APP_COLUMNS } from "@/lib/metrics/app-columns";
import { queryAllPoints } from "@/lib/metrics/store";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { requireAppAdmin } from "@/lib/auth/admin";

// GET /api/v1/admin/stats — system-wide metrics, live or historical via ?from=&to=
export async function GET(request: NextRequest) {
  try {
    await requireAppAdmin();

    if (!isMetricsEnabled()) {
      return NextResponse.json({ series: {}, system: null, disk: null });
    }

    const searchParams = request.nextUrl.searchParams;
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    // Historical query
    if (from && to) {
      const fromMs = parseInt(from);
      const toMs = parseInt(to);
      const bucket = parseInt(searchParams.get("bucket") || "30000");
      // Admin includes GPU series, zeros without GPU data.
      const points = await queryAllPoints(fromMs, toMs, bucket, true);

      return NextResponse.json({ points });
    }

    // Live snapshot
    const [allApps, allMetrics] = await Promise.all([
      db.query.apps.findMany({
        columns: { ...METRICS_APP_COLUMNS, displayName: true },
      }),
      // Disk and system info are slow (3s+) and arrive via the SSE stream.
      fetchAllMetrics(),
    ]);

    const byApp = groupMetricsByApp(allApps, allMetrics);

    const appStats = allApps.map((app) => ({
      ...app,
      containers: (byApp.get(app.id) ?? []).map((m) => ({
        containerId: m.containerId,
        containerName: m.containerName,
        cpuPercent: m.cpuPercent,
        memoryUsage: m.memoryUsage,
        memoryLimit: m.memoryLimit,
        memoryPercent: m.memoryPercent,
        networkRx: m.networkRxBytes,
        networkTx: m.networkTxBytes,
      })),
    }));

    return NextResponse.json({
      apps: appStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return apiError.forbidden();
    }
    return handleRouteError(error, "Error fetching admin stats");
  }
}
