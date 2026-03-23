import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireOrg } from "@/lib/auth/session";
import { on } from "@/lib/bus";

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

    // Subscribe before constructing the stream so that a cap error is caught
    // by the outer try/catch and returned as a 503 instead of leaving the
    // client connected to a stream that never delivers events.
    let unsubscribe: () => void;
    try {
      unsubscribe = on(orgId, (event) => {
        try {
          const eventType = event.type.replace(".", "-");
          controller.enqueue(
            encoder.encode(
              `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`,
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

    let controller!: ReadableStreamDefaultController;

    const stream = new ReadableStream({
      start(ctrl) {
        controller = ctrl;

        // Send keepalive every 30s to prevent connection timeout
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
          }
        }, 30000);

        // Clean up when client disconnects
        request.signal.addEventListener("abort", () => {
          clearInterval(keepalive);
          unsubscribe();
          try {
            controller.close();
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
