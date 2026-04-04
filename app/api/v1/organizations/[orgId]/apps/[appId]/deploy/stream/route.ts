import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { readStream } from "@/lib/stream/consumer";
import { deployStream } from "@/lib/stream/keys";
import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/deploy/stream
//
// SSE stream of deploy log lines and stage transitions via Redis Streams.
// Works identically for live deploys and historical viewing — the stream
// is the single source of truth. No polling, no race conditions.
//
// Query params:
//   deploymentId — specific deploy to stream (optional, defaults to latest running)
//   lastId — resume from this stream entry ID (for reconnection)
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return new Response("Forbidden", { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });

    if (!app) {
      return new Response("Not found", { status: 404 });
    }

    // Determine which deploy to stream
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
    }

    // Check if stream exists; if not, fall back to DB log for historical deploys
    const streamKey = deployStream(deploymentId);
    const streamExists = await (async () => {
      try {
        const len = await (await import("@/lib/redis")).redis.xlen(streamKey);
        return len > 0;
      } catch { return false; }
    })();

    // If stream is empty/evicted, serve historical log from DB
    if (!streamExists) {
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

      // Serve the DB log as a completed SSE stream
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

    const stream = new ReadableStream({
      start(controller) {
        // Keepalive to prevent proxy/browser timeouts
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
          try { controller.close(); } catch { /* already closed */ }
        }

        request.signal.addEventListener("abort", cleanup);

        // Read from Redis Stream — history and live in one continuous flow
        (async () => {
          try {
            const entries = readStream(streamKey, {
              fromId: lastId,
              signal: abortController.signal,
            });

            for await (const entry of entries) {
              const { fields } = entry;

              // Stage transitions
              if (fields.line?.startsWith("[stage]")) {
                sendEvent("stage", {
                  deploymentId,
                  stage: fields.stage,
                  status: fields.status,
                  streamId: entry.id,
                });

                // Auto-close on terminal states
                if (fields.status === "success" || fields.status === "failed" || fields.status === "cancelled") {
                  sendEvent("done", {
                    deploymentId,
                    success: fields.status === "success",
                    status: fields.status,
                    streamId: entry.id,
                  });
                  cleanup();
                  return;
                }
              } else {
                // Log lines
                sendEvent("log", {
                  deploymentId,
                  message: fields.line,
                  stage: fields.stage,
                  streamId: entry.id,
                });
              }
            }
          } catch (err) {
            if (!abortController.signal.aborted) {
              sendEvent("error", {
                message: err instanceof Error ? err.message : "Stream error",
              });
            }
            cleanup();
          }
        })();
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

export const GET = withRateLimit(handleGet, { tier: "read", key: "deploy-stream" });
