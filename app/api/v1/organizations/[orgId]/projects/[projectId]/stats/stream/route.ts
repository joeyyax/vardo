import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { fetchProjectMetrics } from "@/lib/metrics/cadvisor";
import { createSSEResponse } from "@/lib/api/sse";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats/stream
// SSE stream via cAdvisor, polls every 2 seconds
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return new Response("Forbidden", { status: 403 });
    }

    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.organizationId, orgId)
      ),
      columns: { id: true, name: true },
    });

    if (!project) {
      return new Response("Not found", { status: 404 });
    }

    const environment = request.nextUrl.searchParams.get("environment") || undefined;

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
          const metrics = await fetchProjectMetrics(project!.name, environment);

          sendEvent("stats", {
            containers: metrics.map((m) => ({
              containerId: m.containerId,
              containerName: m.containerName,
              cpuPercent: m.cpuPercent,
              memoryUsage: m.memoryUsage,
              memoryLimit: m.memoryLimit,
              memoryPercent: m.memoryPercent,
              networkRx: m.networkRxBytes,
              networkTx: m.networkTxBytes,
              diskUsage: m.diskUsage,
              diskLimit: m.diskLimit,
            })),
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          sendEvent("error", { message: err instanceof Error ? err.message : "Unknown error" });
        }

        if (!stopped) {
          timer = setTimeout(poll, 2000);
        }
      }

      await poll();

      // Keep the handler alive until the client disconnects
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve());
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error streaming stats");
  }
}
