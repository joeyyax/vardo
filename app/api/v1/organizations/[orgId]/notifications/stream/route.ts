import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { readStream } from "@/lib/stream/consumer";
import { eventStream } from "@/lib/stream/keys";
import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/notifications/stream
// SSE stream of org-level bus events (deploy, backup, cron, system alerts, etc.)
// Reads from Redis Streams with catchup + live tail.
//
// Note: The unified SSE gateway at /api/v1/sse is the preferred endpoint
// for new integrations. This endpoint is kept for backward compatibility.
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return new Response("Forbidden", { status: 403 });

    const url = new URL(request.url);
    const lastId = url.searchParams.get("lastId") ?? undefined;

    const encoder = new TextEncoder();
    const abortController = new AbortController();

    const stream = new ReadableStream({
      start(controller) {
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
          }
        }, 30_000);

        const timeout = setTimeout(() => {
          try {
            controller.enqueue(
              encoder.encode(`event: timeout\ndata: ${JSON.stringify({ message: "Stream timed out" })}\n\n`),
            );
          } catch { /* client disconnected */ }
          cleanup();
        }, 10 * 60 * 1000);

        function cleanup() {
          clearInterval(keepalive);
          clearTimeout(timeout);
          abortController.abort();
          try { controller.close(); } catch { /* already closed */ }
        }

        request.signal.addEventListener("abort", cleanup);

        // Read from Redis Stream — catchup + live tail
        (async () => {
          try {
            for await (const entry of readStream(eventStream(orgId), {
              fromId: lastId,
              signal: abortController.signal,
            })) {
              try {
                const payload = entry.fields.payload
                  ? JSON.parse(entry.fields.payload)
                  : entry.fields;
                controller.enqueue(
                  encoder.encode(
                    `event: notification\ndata: ${JSON.stringify({ ...payload, streamId: entry.id })}\n\n`,
                  ),
                );
              } catch { /* skip malformed entries */ }
            }
          } catch (err) {
            if (!abortController.signal.aborted) {
              try {
                controller.enqueue(
                  encoder.encode(`event: error\ndata: ${JSON.stringify({ message: "Stream error" })}\n\n`),
                );
              } catch { /* already closed */ }
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
    return handleRouteError(error, "Error streaming notifications");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "notification-stream" });
