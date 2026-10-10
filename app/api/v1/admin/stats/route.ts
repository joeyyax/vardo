import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { fetchAllMetrics } from "@/lib/metrics/provider";
import { groupMetricsByApp } from "@/lib/metrics/app-match";
import { loadServerApps } from "@/lib/metrics/server-apps";
import { groupServerApps } from "@/lib/metrics/server-groups";
import { queryAllPoints } from "@/lib/metrics/store";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { requireAppAdmin } from "@/lib/auth/admin";

// GET /api/v1/admin/stats — system-wide metrics, live or historical via ?from=&to=
async function handleGet(request: NextRequest) {
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
      loadServerApps(),
      // Disk and system info are slow (3s+) and arrive via the SSE stream.
      fetchAllMetrics(),
    ]);

    const byApp = groupMetricsByApp(allApps, allMetrics);

    const appStats = allApps.map((app) => ({
      ...app,
      containers: (byApp.get(app.id) ?? []).map((m) => ({
        containerId: m.containerId,
        containerName: m.containerName,
        composeService: m.labels["com.docker.compose.service"] ?? null,
        cpuPercent: m.cpuPercent,
        memoryUsage: m.memoryUsage,
        memoryLimit: m.memoryLimit,
        memoryPercent: m.memoryPercent,
        networkRx: m.networkRxBytes,
        networkTx: m.networkTxBytes,
      })),
    }));

    // Organization, project, app; Vardo's own services under `core`.
    const groups = groupServerApps(appStats);

    return NextResponse.json({
      apps: appStats,
      groups,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching admin stats");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/stats" });
