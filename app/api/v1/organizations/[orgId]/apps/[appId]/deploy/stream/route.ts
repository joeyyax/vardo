import { withStreamCap } from "@/lib/api/stream-cap";
import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { tailDeployment } from "@/lib/stream/deploy-tail";
import { deployStream } from "@/lib/stream/keys";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { closeOnShutdown } from "@/lib/shutdown";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/deploy/stream
// SSE stream of deploy log lines and stage transitions via Redis Streams.
// Query: deploymentId (defaults to latest), lastId (resume).
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.view");
    if (!org) return new Response("Forbidden", { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });

    if (!app) {
      return new Response("Not found", { status: 404 });
    }

    const url = new URL(request.url);
    let deploymentId = url.searchParams.get("deploymentId");
    const lastId = url.searchParams.get("lastId") || undefined;

    if (!deploymentId) {
      // Default to the latest running or most recent deploy
      const latest = await db.query.deployments.findFirst({
        where: eq(deployments.appId, appId),
        columns: { id: true, status: true },
        orderBy: [desc(deployments.startedAt)],
      });
      if (!latest) {
        return new Response(JSON.stringify({ error: "No deployments found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      deploymentId = latest.id;
    } else {
      // A caller-supplied id must belong to this app.
      const owned = await db.query.deployments.findFirst({
        where: and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)),
        columns: { id: true },
      });
      if (!owned) {
        return new Response("Not found", { status: 404 });
      }
    }

    // A finished deploy whose stream expired replays from the DB log.
    const streamKey = deployStream(deploymentId);
    const streamExists = await (async () => {
      try {
        const len = await (await import("@/lib/redis")).redis.xlen(streamKey);
        return len > 0;
      } catch { return false; }
    })();
    const current = await db.query.deployments.findFirst({
      where: eq(deployments.id, deploymentId),
      columns: { status: true },
    });
    const inFlight = current?.status === "queued" || current?.status === "running";

    if (!streamExists && !inFlight) {
      const deploy = await db.query.deployments.findFirst({
        where: eq(deployments.id, deploymentId),
        columns: { id: true, status: true, log: true },
      });

      if (!deploy?.log) {
        return new Response(JSON.stringify({ error: "No log data available" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const encoder = new TextEncoder();
      const fallbackStream = new ReadableStream({
        start(ctrl) {
          for (const line of deploy.log!.split("\n")) {
            if (line) {
              try {
                ctrl.enqueue(encoder.encode(`event: log\ndata: ${JSON.stringify({ deploymentId, message: line })}\n\n`));
              } catch { break; }
            }
          }
          try {
            ctrl.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ deploymentId, success: deploy.status === "success", status: deploy.status })}\n\n`));
            ctrl.close();
          } catch { /* already closed */ }
        },
      });

      return new Response(fallbackStream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      });
    }

    const encoder = new TextEncoder();
    const abortController = new AbortController();
    const id = deploymentId;

    const stream = new ReadableStream({
      start(controller) {
        // Keepalive for proxy and browser timeouts.
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
          }
        }, 30_000);

        // Auto-close after 10 minutes
        const timeout = setTimeout(() => {
          sendEvent("timeout", { message: "Stream timed out" });
          cleanup();
        }, 10 * 60 * 1000);

        function sendEvent(event: string, data: unknown) {
          try {
            if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch { /* client disconnected */ }
        }

        function cleanup() {
          clearInterval(keepalive);
          clearTimeout(timeout);
          abortController.abort();
          unregister();
          try { controller.close(); } catch { /* already closed */ }
        }

        const unregister = closeOnShutdown(cleanup);
        request.signal.addEventListener("abort", cleanup);

        // Why it waits while queued, then its Redis stream, then the finished row.
        tailDeployment(
          id,
          {
            onLog: (message, meta) => sendEvent("log", { deploymentId: id, message, stage: meta.stage, streamId: meta.streamId }),
            onStage: (stage, status, meta) => sendEvent("stage", { deploymentId: id, stage, status, streamId: meta.streamId }),
            onWaiting: (message) => sendEvent("log", { deploymentId: id, message: `[queue] ${message}`, stage: "queued" }),
            onStatus: (status) => sendEvent("status", { deploymentId: id, status }),
          },
          { signal: abortController.signal, fromId: lastId },
        )
          .then((result) => {
            if (result) {
              sendEvent("done", {
                deploymentId: id,
                success: result.success,
                status: result.status,
                durationMs: result.durationMs,
                error: result.error,
                postDeployError: result.postDeployError,
              });
            }
            cleanup();
          })
          .catch((err) => {
            if (!abortController.signal.aborted) {
              sendEvent("error", { message: err instanceof Error ? err.message : "Stream error" });
            }
            cleanup();
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
    return handleRouteError(error, "Error streaming deploy logs");
  }
}

export const GET = withStreamCap(withRateLimit(handleGet, { tier: "read", key: "deploy-stream" }));
