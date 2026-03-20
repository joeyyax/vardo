import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";
import { getSystemDiskUsage } from "@/lib/docker/client";

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

    const orgProjects = await db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      columns: { id: true, name: true, displayName: true, status: true },
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        let stopped = false;

        async function poll() {
          if (stopped) return;

          try {
            const allMetrics = await fetchAllContainerMetrics();

            // Group by project using labels
            const byProject: Record<string, typeof allMetrics> = {};
            for (const m of allMetrics) {
              const matched = orgProjects.find(
                (p) => m.projectName === p.name || m.projectName.startsWith(`${p.name}-`)
              );
              if (!matched) continue;
              if (!byProject[matched.id]) byProject[matched.id] = [];
              byProject[matched.id].push(m);
            }

            // Get disk usage (less frequent — it's an expensive call)
            let diskUsage;
            try { diskUsage = await getSystemDiskUsage(); } catch { /* skip */ }

            const payload = {
              projects: orgProjects.map((p) => ({
                ...p,
                containers: (byProject[p.id] || []).map((m) => ({
                  containerId: m.containerId,
                  containerName: m.containerName,
                  cpuPercent: m.cpuPercent,
                  memoryUsage: m.memoryUsage,
                  memoryLimit: m.memoryLimit,
                  memoryPercent: m.memoryPercent,
                  networkRx: m.networkRxBytes,
                  networkTx: m.networkTxBytes,
                  blockRead: 0,
                  blockWrite: 0,
                })),
              })),
              disk: diskUsage || null,
              timestamp: new Date().toISOString(),
            };

            controller.enqueue(
              encoder.encode(`event: stats\ndata: ${JSON.stringify(payload)}\n\n`)
            );
          } catch (err) {
            console.error("[metrics] cAdvisor error:", (err as Error).message);
          }

          if (!stopped) {
            setTimeout(poll, 5000);
          }
        }

        poll();

        request.signal.addEventListener("abort", () => {
          stopped = true;
          try { controller.close(); } catch { /* already closed */ }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return new Response("Unauthorized", { status: 401 });
    }
    console.error("Error streaming org stats:", error);
    return new Response("Internal server error", { status: 500 });
  }
}
