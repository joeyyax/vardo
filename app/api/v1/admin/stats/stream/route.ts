import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { user, apps } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { getSystemInfo } from "@/lib/docker/client";
import { getLatestDiskUsage } from "@/lib/metrics/store";
import { createSSEResponse } from "@/lib/api/sse";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { subscribe } from "@/lib/metrics/broadcast";
import { aggregateContainers, containerToPoint } from "@/lib/metrics/aggregate";

// GET /api/v1/admin/stats/stream
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const dbUser = await db.query.user.findFirst({
      where: eq(user.id, session.user.id),
      columns: { isAppAdmin: true },
    });
    if (!dbUser?.isAppAdmin) {
      return new Response("Forbidden", { status: 403 });
    }

    if (!isMetricsEnabled()) {
      return new Response(null, { status: 204 });
    }

    const allApps = await db.query.apps.findMany({
      columns: { id: true, name: true, displayName: true, status: true, organizationId: true },
    });

    return createSSEResponse(request, async (sendEvent) => {
      let tickCount = 0;
      let cachedSystem: Record<string, unknown> | null = null;
      let cachedDisk: Record<string, unknown> | null = null;

      async function refreshSlowData() {
        try { cachedSystem = await getSystemInfo() as unknown as Record<string, unknown>; } catch { /* skip */ }
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
      }

      refreshSlowData();

      const unsubscribe = subscribe((allMetrics) => {
        const byApp: Record<string, typeof allMetrics> = {};
        for (const m of allMetrics) {
          const matched = allApps.find(
            (app) => m.projectName === app.name || m.projectName.startsWith(`${app.name}-`)
          );
          if (!matched) continue;
          if (!byApp[matched.id]) byApp[matched.id] = [];
          byApp[matched.id].push(m);
        }

        const diskTotal = (cachedDisk as Record<string, unknown> | null)?.total as number ?? 0;
        const point = aggregateContainers(allMetrics, diskTotal);

        const payload: Record<string, unknown> = {
          ...point,
          apps: allApps.map((app) => ({
            id: app.id,
            name: app.name,
            displayName: app.displayName,
            status: app.status,
            organizationId: app.organizationId,
            diskUsage: 0,
            containers: (byApp[app.id] || []).map(containerToPoint),
          })),
        };

        if (cachedSystem) payload.system = cachedSystem;
        if (cachedDisk) payload.disk = cachedDisk;
        if (tickCount > 0 && tickCount % 60 === 0) {
          refreshSlowData();
        }

        sendEvent("point", payload);
        tickCount++;
      });

      request.signal.addEventListener("abort", unsubscribe);

      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve());
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error streaming admin stats");
  }
}
