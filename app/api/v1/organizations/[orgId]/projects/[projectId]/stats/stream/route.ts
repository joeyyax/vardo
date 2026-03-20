import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { fetchProjectMetrics } from "@/lib/metrics/cadvisor";

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

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        async function poll() {
          if (stopped) return;

          try {
            const metrics = await fetchProjectMetrics(project!.name);

            const payload = {
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
            };

            controller.enqueue(
              encoder.encode(`event: stats\ndata: ${JSON.stringify(payload)}\n\n`)
            );
          } catch (err) {
            controller.enqueue(
              encoder.encode(`event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : "Unknown error" })}\n\n`)
            );
          }

          if (!stopped) {
            timer = setTimeout(poll, 2000);
          }
        }

        poll();

        request.signal.addEventListener("abort", () => {
          stopped = true;
          if (timer) clearTimeout(timer);
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
    console.error("Error streaming stats:", error);
    return new Response("Internal server error", { status: 500 });
  }
}
