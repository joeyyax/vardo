import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireOrg } from "@/lib/auth/session";
import { on } from "@/lib/bus";
import type { BusEvent } from "@/lib/bus/events";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/notifications/stream
// SSE stream of org-level bus events (deploy, backup, cron, system alerts, etc.)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return new Response("Forbidden", { status: 403 });
    }

    const encoder = new TextEncoder();

    // Buffer events until the controller is ready. The Redis subscriber
    // callback can fire before ReadableStream.start() assigns the controller.
    let controller: ReadableStreamDefaultController | null = null;
    const pending: BusEvent[] = [];

    let unsubscribe: () => void;
    try {
      unsubscribe = on(orgId, (event) => {
        if (!controller) {
          pending.push(event);
          return;
        }
        try {
          controller.enqueue(
            encoder.encode(
              `event: notification\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
        } catch {
          // Client disconnected
        }
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Subscriber cap reached";
      return new Response(JSON.stringify({ error: msg }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const stream = new ReadableStream({
      start(ctrl) {
        controller = ctrl;

        // Flush any events that arrived before the controller was ready
        for (const event of pending) {
          try {
            ctrl.enqueue(
              encoder.encode(
                `event: notification\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
          } catch {
            break;
          }
        }
        pending.length = 0;

        const keepalive = setInterval(() => {
          try {
            ctrl.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
          }
        }, 30000);

        request.signal.addEventListener("abort", () => {
          clearInterval(keepalive);
          unsubscribe();
          try {
            ctrl.close();
          } catch {
            /* already closed */
          }
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
    return handleRouteError(error, "Error streaming notifications");
  }
}
