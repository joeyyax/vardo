import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isCollectorRunning, startCollector } from "@/lib/metrics/collector";
import { getLatestProjectDiskUsage } from "@/lib/metrics/store";
import { getSystemInfo } from "@/lib/docker/client";
import { createSSEResponse } from "@/lib/api/sse";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { subscribe } from "@/lib/metrics/broadcast";
import { aggregateContainers, containerToPoint } from "@/lib/metrics/aggregate";
import { groupMetricsByApp, dedupeMetrics } from "@/lib/metrics/app-match";
import { METRICS_APP_COLUMNS } from "@/lib/metrics/app-columns";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/stats/stream
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return new Response("Forbidden", { status: 403 });

    if (!isMetricsEnabled()) {
      return new Response(null, { status: 204 });
    }

    async function loadApps() {
      return db.query.apps.findMany({
        where: eq(apps.organizationId, orgId),
        columns: { ...METRICS_APP_COLUMNS, displayName: true, projectId: true },
      });
    }

    let orgApps = await loadApps();

    // Denominator for the CPU figure — container percentages sum past 100 on a
    // multi-core host.
    let cpuCount = 0;
    try {
      cpuCount = (await getSystemInfo()).cpus;
    } catch { /* skip */ }

    if (!isCollectorRunning()) {
      startCollector();
    }

    return createSSEResponse(request, async (sendEvent) => {
      let tickCount = 0;

      // Slow data cache — org-scoped (per-app disk only, no system-wide stats)
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

      // App rows carry status, so a connection held open for hours would
      // otherwise render whatever the statuses were when it opened.
      async function refreshApps() {
        try {
          orgApps = await loadApps();
        } catch { /* skip */ }
      }

      // Start app disk fetch in background
      refreshAppDisk();

      const unsubscribe = subscribe((allMetrics) => {
        const byApp = groupMetricsByApp(orgApps, allMetrics);

        const allOrgContainers = dedupeMetrics(byApp.values());
        const orgDiskTotal = Object.values(cachedAppDisk).reduce((s, v) => s + v, 0);
        const point = aggregateContainers(allOrgContainers, orgDiskTotal);
        const projectCount = new Set(orgApps.map((a) => a.projectId).filter(Boolean)).size;

        sendEvent("point", {
          ...point,
          projectCount,
          cpuCount,
          orgDiskTotal,
          apps: orgApps.map((p) => ({
            ...p,
            diskUsage: cachedAppDisk[p.id] || 0,
            containers: (byApp.get(p.id) ?? []).map(containerToPoint),
          })),
        });

        tickCount++;
        if (tickCount % 10 === 0) {
          refreshApps();
        }
        if (tickCount % 60 === 0) {
          refreshAppDisk();
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
