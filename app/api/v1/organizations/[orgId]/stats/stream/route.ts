import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";
import { getProjectContainers, getContainerStats } from "@/lib/docker/client";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/stats/stream
// SSE stream of aggregated stats across all projects
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
            // Try cAdvisor first, fall back to Docker stats API
            let projectData;
            try {
              const allMetrics = await fetchAllContainerMetrics();
              if (allMetrics.length === 0) throw new Error("No metrics from cAdvisor");
              const byProject: Record<string, typeof allMetrics> = {};
              for (const m of allMetrics) {
                const matched = orgProjects.find(
                  (p) => m.projectName === p.name || m.projectName.startsWith(`${p.name}-`)
                );
                if (!matched) continue;
                if (!byProject[matched.id]) byProject[matched.id] = [];
                byProject[matched.id].push(m);
              }
              projectData = orgProjects.map((p) => ({
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
                  diskUsage: m.diskUsage,
                  diskLimit: m.diskLimit,
                })),
              }));
            } catch (cadvisorErr) {
              // cAdvisor not available — fall back to Docker stats
              console.log("[metrics] cAdvisor unavailable, falling back to Docker stats:", (cadvisorErr as Error).message);
              const activeProjects = orgProjects.filter((p) => p.status === "active");
              const results = await Promise.allSettled(
                activeProjects.map(async (p) => {
                  const containers = await getProjectContainers(p.name);
                  console.log(`[metrics] ${p.name}: found ${containers.length} containers`);
                  const stats = await Promise.allSettled(
                    containers.map((c) => getContainerStats(c.Id))
                  );
                  return {
                    id: p.id,
                    containers: stats
                      .filter((s): s is PromiseFulfilledResult<any> => s.status === "fulfilled")
                      .map((s) => s.value),
                  };
                })
              );

              const byId: Record<string, any[]> = {};
              for (const r of results) {
                if (r.status === "fulfilled") {
                  byId[r.value.id] = r.value.containers;
                }
              }

              projectData = orgProjects.map((p) => ({
                ...p,
                containers: byId[p.id] || [],
              }));
            }

            const payload = {
              projects: projectData,
              timestamp: new Date().toISOString(),
            };

            controller.enqueue(
              encoder.encode(`event: stats\ndata: ${JSON.stringify(payload)}\n\n`)
            );
          } catch {
            // Both failed — skip this tick
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
