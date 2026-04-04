import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { readStream } from "@/lib/stream/consumer";
import { eventStream } from "@/lib/stream/keys";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import type { BusEvent } from "@/lib/bus/events";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/events
// SSE stream of app state changes (deploy status, container status, etc.)
//
// Reads from the org-scoped event stream and filters to events matching
// the requested appId. Uses Redis Streams (readStream) for catchup + live tail.
//
// Query params:
//   lastId — resume from this stream entry ID (for reconnection)
async function handleGet(request: NextRequest, { params }: RouteParams) {
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

    const url = new URL(request.url);
    const lastId = url.searchParams.get("lastId") || undefined;

    const encoder = new TextEncoder();
    const abortController = new AbortController();

    const stream = new ReadableStream({
      start(controller) {
        // Keepalive to prevent proxy/browser timeouts
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
          }
        }, 30_000);

        // Auto-close after 30 minutes
        const timeout = setTimeout(() => {
          cleanup();
        }, 30 * 60 * 1000);

        function sendEvent(event: string, data: unknown) {
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

        // Read from the org event stream, filtering to this app's events
        (async () => {
          try {
            const entries = readStream(eventStream(orgId), {
              fromId: lastId,
              signal: abortController.signal,
            });

            for await (const entry of entries) {
              const { fields } = entry;

              // Parse the BusEvent payload and filter by appId
              let busEvent: BusEvent;
              try {
                busEvent = JSON.parse(fields.payload) as BusEvent;
              } catch {
                continue; // Skip malformed entries
              }

              // Only forward events that belong to this app
              if (!("appId" in busEvent) || busEvent.appId !== appId) {
                continue;
              }

              // Map BusEvent type to SSE event name for frontend compatibility.
              // The old pub/sub system used event names like "deploy:complete",
              // "deploy:stage", etc. BusEvents use dot notation (deploy.success,
              // deploy.failed). Map to the "update" event with the full payload
              // to maintain the same shape the frontend expects.
              sendEvent("update", {
                ...busEvent,
                event: busEvent.type,
                streamId: entry.id,
              });
            }
          } catch (err) {
            if (!abortController.signal.aborted) {
              sendEvent("error", {
                message: err instanceof Error ? err.message : "Stream error",
              });
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
    return handleRouteError(error, "Error streaming events");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "app-events" });
