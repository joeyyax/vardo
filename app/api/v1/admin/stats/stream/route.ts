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
          return {
            id: app.id,
            name: app.name,
            displayName: app.displayName,
            status: app.status,
            organizationId: app.organizationId,
            containers,
          };
        });

        const payload: Record<string, unknown> = {
          apps: appStats,
          timestamp: new Date().toISOString(),
        };

        // Always include slow data if available, refresh every 60 ticks
        if (cachedSystem) payload.system = cachedSystem;
        if (cachedDisk) payload.disk = cachedDisk;
        if (tickCount > 0 && tickCount % 60 === 0) {
          refreshSlowData();
        }

        sendEvent("stats", payload);
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
