import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { getProjectContainers, getContainerStats } from "@/lib/docker/client";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats/stream
// SSE stream that polls Docker stats every 2 seconds
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

        async function poll() {
          if (stopped) return;

          try {
            const containers = await getProjectContainers(project!.name);
            const running = containers.filter((c) => c.state === "running");

            if (running.length === 0) {
              controller.enqueue(
                encoder.encode(`event: stats\ndata: ${JSON.stringify({ containers: [], timestamp: new Date().toISOString() })}\n\n`)
              );
            } else {
              const stats = await Promise.allSettled(
                running.map((c) => getContainerStats(c.id))
              );

              const resolved = stats
                .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof getContainerStats>>> => r.status === "fulfilled")
                .map((r) => r.value);

              controller.enqueue(
                encoder.encode(`event: stats\ndata: ${JSON.stringify({ containers: resolved, timestamp: new Date().toISOString() })}\n\n`)
              );
            }
          } catch (err) {
            // Send error but keep stream alive
            controller.enqueue(
              encoder.encode(`event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : "Unknown error" })}\n\n`)
            );
          }

          if (!stopped) {
            timer = setTimeout(poll, 2000);
          }
        }

        let timer: ReturnType<typeof setTimeout> | null = null;

        // Start polling immediately
        poll();

        // Clean up on client disconnect
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
