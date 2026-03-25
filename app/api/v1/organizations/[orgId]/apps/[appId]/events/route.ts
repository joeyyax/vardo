import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { subscribe, appChannel } from "@/lib/events";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/events
// SSE stream of app state changes (deploy status, container status, etc.)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return new Response("Forbidden", { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: { id: true },
    });

    if (!app) {
      return new Response("Not found", { status: 404 });
    }

    const encoder = new TextEncoder();

    // Subscribe before constructing the stream so that a cap error is caught
    // by the outer try/catch and returned as a 503 instead of leaving the
    // client connected to a stream that never delivers events.
    let unsubscribe: () => void;
    try {
      unsubscribe = subscribe(appChannel(appId), (data) => {
        try {
          const event = (data.event as string) || "update";
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // Client disconnected
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Subscriber cap reached";
      return new Response(JSON.stringify({ error: msg }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    // `controller` is assigned synchronously inside ReadableStream.start before
    // any messages can arrive (Redis messages are async), so the closure above
    // is safe to reference it.
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
  } catch (error) {
    return handleRouteError(error, "Error streaming events");
  }
}
