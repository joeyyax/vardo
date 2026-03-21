import type { NextRequest } from "next/server";

/**
 * Create an SSE (Server-Sent Events) Response from an async handler.
 * The handler receives a `sendEvent` function to emit events.
 */
export function createSSEResponse(
  request: NextRequest,
  handler: (sendEvent: (event: string, data: unknown) => void) => Promise<void>
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      function sendEvent(event: string, data: unknown) {
        try {
          // Backpressure: skip events if the client can't keep up
          if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch { /* stream closed */ }
      }

      handler(sendEvent)
        .then(() => {
          try { controller.close(); } catch { /* already closed */ }
        })
        .catch((err) => {
          sendEvent("error", { message: err instanceof Error ? err.message : "Unknown error" });
          try { controller.close(); } catch { /* already closed */ }
        });

      request.signal.addEventListener("abort", () => {
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
