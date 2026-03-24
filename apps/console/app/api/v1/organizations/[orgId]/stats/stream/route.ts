import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { isCollectorRunning, startCollector } from "@/lib/metrics/collector";
import { getLatestProjectDiskUsage } from "@/lib/metrics/store";
import { createSSEResponse } from "@/lib/api/sse";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { subscribe } from "@/lib/metrics/broadcast";
import { aggregateContainers, containerToPoint } from "@/lib/metrics/aggregate";

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
      columns: { id: true, name: true, displayName: true, status: true, projectId: true },
    });
    const projectCount = new Set(orgApps.map((a) => a.projectId).filter(Boolean)).size;

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

      // Start app disk fetch in background
      refreshAppDisk();

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

        const allOrgContainers = Object.values(byApp).flat();
        const orgDiskTotal = Object.values(cachedAppDisk).reduce((s, v) => s + v, 0);
        const point = aggregateContainers(allOrgContainers, orgDiskTotal);

        sendEvent("point", {
          ...point,
          projectCount,
          orgDiskTotal,
          apps: orgApps.map((p) => ({
            ...p,
            diskUsage: cachedAppDisk[p.id] || 0,
            containers: (byApp[p.id] || []).map(containerToPoint),
          })),
        });

        tickCount++;
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
