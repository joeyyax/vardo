import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { subscribe, appChannel } from "@/lib/events";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/events
// SSE stream of app state changes (deploy status, container status, etc.)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return new Response("Forbidden", { status: 403 });
    }

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
    const stream = new ReadableStream({
      start(controller) {
        // Send keepalive every 30s to prevent connection timeout
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
          }
        }, 30000);

        // Subscribe to app events via Redis pub/sub
        const unsubscribe = subscribe(
          appChannel(appId),
          (data) => {
            try {
              const event = data.event as string || "update";
              controller.enqueue(
                encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
              );
            } catch {
              // Client disconnected
            }
          }
        );

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
