import type { NextRequest } from "next/server";
import { extractIdentifier } from "./with-rate-limit";

/** Open SSE connections per session or token, across every stream route. */
export const MAX_STREAMS_PER_USER = 60;

// Per process; Vardo runs one console instance.
const open = new Map<string, number>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (request: NextRequest, context: any) => Promise<Response>;

function release(id: string) {
  const n = (open.get(id) ?? 0) - 1;
  if (n > 0) open.set(id, n);
  else open.delete(id);
}

/** Counts open connections for tests. */
export function openStreamCount(id: string): number {
  return open.get(id) ?? 0;
}

/** Caps concurrent SSE connections per caller; the slot frees when the stream closes. */
export function withStreamCap(handler: RouteHandler, max = MAX_STREAMS_PER_USER): RouteHandler {
  return async (request, context) => {
    const id = extractIdentifier(request);
    if ((open.get(id) ?? 0) >= max) {
      return Response.json(
        { error: "Too many open streams. Close a tab and retry." },
        { status: 429, headers: { "Retry-After": "10" } },
      );
    }

    open.set(id, (open.get(id) ?? 0) + 1);
    let freed = false;
    const free = () => {
      if (freed) return;
      freed = true;
      release(id);
    };

    let res: Response;
    try {
      res = await handler(request, context);
    } catch (err) {
      free();
      throw err;
    }

    // Auth failures and errors return plain responses; only a live stream holds a slot.
    if (!res.body || !res.headers.get("content-type")?.includes("text/event-stream")) {
      free();
      return res;
    }

    request.signal.addEventListener("abort", free, { once: true });
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            free();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (err) {
          free();
          controller.error(err);
        }
      },
      cancel(reason) {
        free();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
