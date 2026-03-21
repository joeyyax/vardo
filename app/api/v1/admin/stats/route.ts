import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { user, apps } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";
import { queryAll, queryDiskHistory } from "@/lib/metrics/store";
import { getSystemDiskUsage } from "@/lib/docker/client";
import { isMetricsEnabled } from "@/lib/metrics/config";

// GET /api/v1/admin/stats
// System-wide metrics: all containers across all orgs
// Supports live snapshot or historical query via ?from=&to=
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const dbUser = await db.query.user.findFirst({
      where: eq(user.id, session.user.id),
      columns: { isAppAdmin: true },
    });
    if (!dbUser?.isAppAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
      const agg = { type: "avg" as const, bucketMs: bucket };

      const [cpu, memory, networkRx, networkTx, disk] = await Promise.all([
        queryAll("cpu", fromMs, toMs, agg),
        queryAll("memory", fromMs, toMs, agg),
        queryAll("networkRx", fromMs, toMs, { type: "sum", bucketMs: bucket }),
        queryAll("networkTx", fromMs, toMs, { type: "sum", bucketMs: bucket }),
        queryDiskHistory(fromMs, toMs, bucket),
      ]);

      return NextResponse.json({
        from: fromMs,
        to: toMs,
        bucketMs: bucket,
        series: { cpu, memory, networkRx, networkTx, disk },
      });
    }

    // Live snapshot
    const allApps = await db.query.apps.findMany({
      columns: { id: true, name: true, displayName: true, status: true, organizationId: true },
    });

    // Only fetch fast data synchronously — disk and system info are slow (3s+)
    // and will arrive via the SSE stream instead
    const allMetrics = await fetchAllContainerMetrics();

    // Group containers by app
    const appStats = allApps.map((app) => {
      const containers = allMetrics
        .filter((m) => m.projectName === app.name || m.projectName.startsWith(`${app.name}-`))
        .map((m) => ({
          containerId: m.containerId,
          containerName: m.containerName,
          cpuPercent: m.cpuPercent,
          memoryUsage: m.memoryUsage,
          memoryLimit: m.memoryLimit,
          memoryPercent: m.memoryPercent,
          networkRx: m.networkRxBytes,
          networkTx: m.networkTxBytes,
        }));
      return { ...app, containers };
    });

    return NextResponse.json({
      apps: appStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching admin stats");
  }
}
