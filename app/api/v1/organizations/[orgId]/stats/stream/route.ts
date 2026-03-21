import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { getSystemInfo, type DiskUsage, type SystemInfo } from "@/lib/docker/client";
import { isCollectorRunning, startCollector } from "@/lib/metrics/collector";
import { getLatestProjectDiskUsage, getLatestDiskUsage } from "@/lib/metrics/store";
import { createSSEResponse } from "@/lib/api/sse";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { subscribe } from "@/lib/metrics/broadcast";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/stats/stream
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return new Response("Forbidden", { status: 403 });
    }

    if (!isMetricsEnabled()) {
      return new Response(null, { status: 204 });
    }

    const orgApps = await db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      columns: { id: true, name: true, displayName: true, status: true },
    });

    if (!isCollectorRunning()) {
      startCollector();
    }

    return createSSEResponse(request, async (sendEvent) => {
      let tickCount = 0;

      // Slow data cache
      let cachedDisk: DiskUsage | null = null;
      let cachedSystem: SystemInfo | null = null;
      let cachedAppDisk: Record<string, number> = {};

      async function refreshAppDisk() {
        try {
          const diskEntries = await Promise.all(
            orgApps.map(async (p) => {
              const size = await getLatestProjectDiskUsage(p.name);
              return [p.id, size] as const;
            })
          );
          const result: Record<string, number> = {};
          for (const [id, size] of diskEntries) {
            if (size !== null && size > 0) result[id] = size;
          }
          cachedAppDisk = result;
        } catch { /* skip */ }
      }

      async function refreshSlowData() {
        try {
          const d = await getLatestDiskUsage();
          if (d) {
            cachedDisk = {
              images: { count: 0, totalSize: d.images, reclaimable: 0 },
              containers: { count: 0, totalSize: 0 },
              volumes: { count: 0, totalSize: d.volumes },
              buildCache: { count: 0, totalSize: d.buildCache, reclaimable: 0 },
              total: d.total,
            };
          }
        } catch { /* skip */ }
        try { cachedSystem = await getSystemInfo(); } catch { /* skip */ }
        await refreshAppDisk();
      }

      // Start slow data fetch in background
      refreshSlowData();

      const unsubscribe = subscribe((allMetrics) => {
        const byApp: Record<string, typeof allMetrics> = {};
        for (const m of allMetrics) {
          const matched = orgApps.find(
            (p) => m.projectName === p.name || m.projectName.startsWith(`${p.name}-`)
          );
          if (!matched) continue;
          if (!byApp[matched.id]) byApp[matched.id] = [];
          byApp[matched.id].push(m);
        }

        sendEvent("stats", {
          apps: orgApps.map((p) => ({
            ...p,
            diskUsage: cachedAppDisk[p.id] || 0,
            containers: (byApp[p.id] || []).map((m) => ({
              containerId: m.containerId,
              containerName: m.containerName,
              cpuPercent: m.cpuPercent,
              memoryUsage: m.memoryUsage,
              memoryLimit: m.memoryLimit,
              memoryPercent: m.memoryPercent,
              networkRx: m.networkRxBytes,
              networkTx: m.networkTxBytes,
              diskUsage: m.diskUsage,
            })),
          })),
          disk: cachedDisk,
          system: cachedSystem,
          timestamp: new Date().toISOString(),
        });

        tickCount++;
        if (tickCount % 60 === 0) {
          refreshSlowData();
        }
      });

      request.signal.addEventListener("abort", unsubscribe);

      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve());
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error streaming org stats");
  }
}
