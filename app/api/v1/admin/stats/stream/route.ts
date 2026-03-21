import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { user, apps } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";
import { getSystemDiskUsage, getSystemInfo } from "@/lib/docker/client";
import { createSSEResponse } from "@/lib/api/sse";
import { isMetricsEnabled } from "@/lib/metrics/config";

// GET /api/v1/admin/stats/stream
// SSE stream of system-wide metrics (all containers across all orgs)
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
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let tickCount = 0;

      request.signal.addEventListener("abort", () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      });

      async function poll() {
        if (stopped) return;

        try {
          const allMetrics = await fetchAllContainerMetrics();

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

          // Slow data: system info + disk (every 60 ticks = ~5 min)
          if (tickCount % 60 === 0) {
            const [system, disk] = await Promise.all([
              getSystemInfo().catch(() => null),
              getSystemDiskUsage().catch(() => null),
            ]);
            payload.system = system;
            payload.disk = disk;
          }

          sendEvent("stats", payload);
          tickCount++;
        } catch (err) {
          sendEvent("error", { message: err instanceof Error ? err.message : "Unknown error" });
        }

        if (!stopped) {
          timer = setTimeout(poll, 5000);
        }
      }

      await poll();

      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve());
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error streaming admin stats");
  }
}
