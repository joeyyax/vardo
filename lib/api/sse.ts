import type { NextRequest } from "next/server";
import { closeOnShutdown } from "@/lib/shutdown";

/** Default SSE idle timeout: 10 minutes */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Events the stream will buffer for a client that is reading normally. */
const BUFFER_CHUNKS = 1024;

/** How far past the buffer a client must fall before its events are dropped. */
const STALLED_CLIENT_CHUNKS = 4096;

type SSEOptions = {
  /** Timeout in ms before the stream auto-closes. Set to 0 to disable. */
  timeoutMs?: number;
};

/**
 * Create an SSE (Server-Sent Events) Response from an async handler.
 * The handler receives a `sendEvent` function to emit events.
 *
 * Streams auto-close after `timeoutMs` (default 10 min) to prevent
 * zombie connections from idle tabs. The client receives a `timeout`
 * event and can reconnect to resume.
 */
export function createSSEResponse(
  request: NextRequest,
  handler: (sendEvent: (event: string, data: unknown) => void) => Promise<void>,
  options?: SSEOptions,
) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      let dropped = 0;

      function sendEvent(event: string, data: unknown) {
        try {
          // Only a client that has stopped reading entirely gets dropped. The
          // previous check dropped at desiredSize <= 0, which a default stream
          // reaches after one enqueue — a 200-line backfill delivered 10.
          if (controller.desiredSize !== null && controller.desiredSize <= -STALLED_CLIENT_CHUNKS) {
            dropped++;
            return;
          }
          if (dropped > 0) {
            const lost = dropped;
            dropped = 0;
            controller.enqueue(
              encoder.encode(`event: dropped\ndata: ${JSON.stringify({ count: lost })}\n\n`),
            );
          }
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch { /* stream closed */ }
      }

      const unregister = closeOnShutdown(() => {
        sendEvent("shutdown", { message: "Server shutting down, reconnect to resume" });
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      });

      function cleanup() {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        unregister();
      }

      // Auto-close after timeout
      if (timeoutMs > 0) {
        idleTimer = setTimeout(() => {
          sendEvent("timeout", { message: "Stream timed out", timeoutMs });
          try { controller.close(); } catch { /* already closed */ }
        }, timeoutMs);
      }

      handler(sendEvent)
        .then(() => {
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        })
        .catch((err) => {
          cleanup();
          sendEvent("error", { message: err instanceof Error ? err.message : "Unknown error" });
          try { controller.close(); } catch { /* already closed */ }
        });

      request.signal.addEventListener("abort", () => {
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  }, new CountQueuingStrategy({ highWaterMark: BUFFER_CHUNKS }));

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
