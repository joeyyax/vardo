import type { NextRequest } from "next/server";

/** Default SSE idle timeout: 10 minutes */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

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

      function sendEvent(event: string, data: unknown) {
        try {
          // Backpressure: skip events if the client can't keep up
          if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch { /* stream closed */ }
      }

      function cleanup() {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
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
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
