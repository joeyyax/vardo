import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { readStream } from "@/lib/stream/consumer";
import { eventStream } from "@/lib/stream/keys";
import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

/** How far back a reconnect may replay. Beyond this, start live. */
const CATCHUP_MAX_AGE_MS = 5 * 60_000;

/** Milliseconds from a Redis stream ID ("<ms>-<seq>"). 0 if unparseable. */
function streamIdMs(id: string): number {
  return Number.parseInt(id.split("-")[0] ?? "", 10) || 0;
}

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
    // Catch-up covers a dropped connection, not days away. Replaying an old
    // cursor toasted every event the user missed, so anything past the window
    // starts live instead; the notification panel is where history belongs.
    const connectedAt = Date.now();
    const requestedLastId = url.searchParams.get("lastId");
    const withinCatchup =
      requestedLastId !== null &&
      connectedAt - streamIdMs(requestedLastId) <= CATCHUP_MAX_AGE_MS;
    const lastId = withinCatchup ? requestedLastId! : "$";

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
                    `event: notification\ndata: ${JSON.stringify({
                      ...payload,
                      streamId: entry.id,
                      // Delivered by catch-up, not live — the client keeps it
                      // out of the toast queue.
                      historical: streamIdMs(entry.id) < connectedAt,
                    })}\n\n`,
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
