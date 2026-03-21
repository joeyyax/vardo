import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";
import { getSystemDiskUsage, getSystemInfo, type DiskUsage, type SystemInfo } from "@/lib/docker/client";
import { isCollectorRunning, startCollector } from "@/lib/metrics/collector";
import { getLatestProjectDiskUsage } from "@/lib/metrics/store";
import { createSSEResponse } from "@/lib/api/sse";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/stats/stream
// SSE stream of aggregated stats across all projects via cAdvisor
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return new Response("Forbidden", { status: 403 });
    }

    const orgApps = await db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      columns: { id: true, name: true, displayName: true, status: true },
    });

    // Ensure metrics collector is running (fallback if instrumentation didn't start it)
    if (!isCollectorRunning()) {
      startCollector();
    }

    return createSSEResponse(request, async (sendEvent) => {
      let stopped = false;
      let tickCount = 0;

      // Cache slow calls
      let cachedDisk: DiskUsage | null = null;
      let cachedSystem: SystemInfo | null = null;
      let cachedAppDisk: Record<string, number> = {};

      // Fetch per-project disk from Redis (fast — just TS.GET per project)
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
            if (size !== null && size > 0) {
              result[id] = size;
            }
          }
          cachedAppDisk = result;
        } catch { /* skip */ }
      }

      // Fetch slow Docker API data in background (don't block SSE ticks)
      async function refreshSlowData() {
        try { cachedDisk = await getSystemDiskUsage(); } catch { /* skip */ }
        try { cachedSystem = await getSystemInfo(); } catch { /* skip */ }
        await refreshAppDisk();
      }

      // Start slow data fetch in background — don't block first SSE tick
      refreshSlowData();

      request.signal.addEventListener("abort", () => {
        stopped = true;
      });

      async function poll() {
        if (stopped) return;

        try {
          // Fast path: just cAdvisor stats (~10ms)
          const allMetrics = await fetchAllContainerMetrics();

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

          // Refresh slow data every 60 ticks (~5 min at 5s intervals)
          tickCount++;
          if (tickCount % 60 === 0) {
            refreshSlowData(); // Fire and forget — don't await
          }
        } catch (err) {
          console.error("[metrics] cAdvisor error:", (err as Error).message);
        }

        if (!stopped) {
          setTimeout(poll, 5000);
        }
      }

      await poll();

      // Keep the handler alive until the client disconnects
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve());
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error streaming org stats");
  }
}
