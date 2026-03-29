import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";
import { queryAllPoints } from "@/lib/metrics/store";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { requireAppAdmin } from "@/lib/auth/admin";

// GET /api/v1/admin/stats
// System-wide metrics: all containers across all orgs
// Supports live snapshot or historical query via ?from=&to=
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
      // Admin sees all metrics — always include GPU series (returns zeros when no GPU data)
      const points = await queryAllPoints(fromMs, toMs, bucket, true);

      return NextResponse.json({ points });
    }

    // Live snapshot
    const [allApps, allMetrics] = await Promise.all([
      db.query.apps.findMany({
        columns: { id: true, name: true, displayName: true, status: true, organizationId: true },
      }),
      // Only fetch fast data synchronously — disk and system info are slow (3s+)
      // and will arrive via the SSE stream instead
      fetchAllContainerMetrics(),
    ]);

    // Index metrics by projectName to avoid O(apps * metrics) nested scans
    const metricsByProject = new Map<string, typeof allMetrics>();
    for (const m of allMetrics) {
      const existing = metricsByProject.get(m.projectName);
      if (existing) {
        existing.push(m);
      } else {
        metricsByProject.set(m.projectName, [m]);
      }
    }

    // Group containers by app
    const appStats = allApps.map((app) => {
      const prefix = `${app.name}-`;
      const containers: {
        containerId: string;
        containerName: string;
        cpuPercent: number;
        memoryUsage: number;
        memoryLimit: number;
        memoryPercent: number;
        networkRx: number;
        networkTx: number;
      }[] = [];

      for (const [key, metrics] of metricsByProject) {
        if (key === app.name || key.startsWith(prefix)) {
          for (const m of metrics) {
            containers.push({
              containerId: m.containerId,
              containerName: m.containerName,
              cpuPercent: m.cpuPercent,
              memoryUsage: m.memoryUsage,
              memoryLimit: m.memoryLimit,
              memoryPercent: m.memoryPercent,
              networkRx: m.networkRxBytes,
              networkTx: m.networkTxBytes,
            });
          }
        }
      }

      return { ...app, containers };
    });

    return NextResponse.json({
      apps: appStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error fetching admin stats");
  }
}
