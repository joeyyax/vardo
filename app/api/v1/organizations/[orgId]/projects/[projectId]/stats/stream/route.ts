import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";
import { createSSEResponse } from "@/lib/api/sse";
import { isMetricsEnabled } from "@/lib/metrics/config";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats/stream
// Single SSE connection for all apps in a project
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return new Response("Forbidden", { status: 403 });
    }

    if (!isMetricsEnabled()) {
      return new Response(null, { status: 204 });
    }

    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });
    if (!project) {
      return new Response("Not found", { status: 404 });
    }

    const projectApps = await db.query.apps.findMany({
      where: and(eq(apps.projectId, projectId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, displayName: true, status: true },
    });

    return createSSEResponse(request, async (sendEvent) => {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      request.signal.addEventListener("abort", () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      });

      async function poll() {
        if (stopped) return;

        try {
          const allMetrics = await fetchAllContainerMetrics();

          const appStats = projectApps.map((app) => {
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
            return { id: app.id, name: app.name, containers };
          });

          sendEvent("stats", {
            apps: appStats,
            timestamp: new Date().toISOString(),
          });
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
    return handleRouteError(error, "Error streaming project stats");
  }
}
