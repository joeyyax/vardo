import { NextRequest } from "next/server";
import { requireOrg } from "@/lib/auth/session";
import { lockRequestChannel } from "@/lib/document-locks";
import Redis from "ioredis";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; documentId: string }>;
};

// GET — SSE stream for lock status changes and edit requests
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, documentId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return new Response("Forbidden", { status: 403 });
    }

    const channel = lockRequestChannel(documentId);

    // Create a dedicated subscriber connection (required by ioredis for pub/sub)
    const subscriber = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    await subscriber.connect();

    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream({
      start(controller) {
        // Send initial keepalive
        controller.enqueue(encoder.encode(": connected\n\n"));

        // Subscribe to the lock request channel
        subscriber.subscribe(channel).catch(() => {
          if (!closed) controller.close();
        });

        subscriber.on("message", (_ch: string, message: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${message}\n\n`));
          } catch {
            // Stream closed
          }
        });

        // Periodic keepalive every 30s
        const keepalive = setInterval(() => {
          if (closed) {
            clearInterval(keepalive);
            return;
          }
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
          }
        }, 30_000);

        // Clean up on abort
        request.signal.addEventListener("abort", () => {
          closed = true;
          clearInterval(keepalive);
          subscriber.unsubscribe(channel).catch(() => {});
          subscriber.disconnect();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        });
      },
      cancel() {
        closed = true;
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.disconnect();
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
    if (error instanceof Error && error.message === "Unauthorized") {
      return new Response("Unauthorized", { status: 401 });
    }
    console.error("Error in lock poll:", error);
    return new Response("Internal server error", { status: 500 });
  }
}
