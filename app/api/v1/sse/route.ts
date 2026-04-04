import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { getSession } from "@/lib/auth/session";
import { startGateway } from "@/lib/sse/gateway";

// GET /api/v1/sse?org={orgId}&deploy={deployId}&lastEventId=&lastDeployId=&lastToastId=
//
// Unified SSE endpoint. Multiplexes org events, deploy logs, and user toasts
// into a single connection. The client receives typed events:
//
//   event: event       — org-level events (deploy status, backup, system alerts)
//   event: deploy-log  — deploy log lines (when deploy param provided)
//   event: deploy-stage — deploy stage transitions
//   event: toast       — user toasts (temp, progress, persistent)
//
// Reconnection: pass lastEventId/lastDeployId/lastToastId to resume
// from where you left off. No missed events, no duplicates.
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const orgId = url.searchParams.get("org");
    if (!orgId) {
      return new Response(
        JSON.stringify({ error: "org parameter required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const deployId = url.searchParams.get("deploy") ?? undefined;
    const lastEventId = url.searchParams.get("lastEventId") ?? undefined;
    const lastDeployId = url.searchParams.get("lastDeployId") ?? undefined;
    const lastToastId = url.searchParams.get("lastToastId") ?? undefined;

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
          send("timeout", { message: "Stream timed out, reconnect to resume" });
          cleanup();
        }, 10 * 60 * 1000);

        function send(event: string, data: unknown) {
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

        // Start the gateway — reads from multiple streams, dispatches via send()
        startGateway(
          {
            orgId,
            userId: session!.user.id,
            deployId,
            lastEventId,
            lastDeployId,
            lastToastId,
            signal: abortController.signal,
          },
          send,
        );
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
    return handleRouteError(error, "SSE gateway error");
  }
}
