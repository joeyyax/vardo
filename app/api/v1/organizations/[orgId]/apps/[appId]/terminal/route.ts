import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { listContainers } from "@/lib/docker/client";
import { createExec, startExec, resizeExec } from "@/lib/docker/exec";
import { requirePlugin } from "@/lib/api/require-plugin";
import net from "node:net";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

// ---------------------------------------------------------------------------
// Session store — maps sessionId to exec socket and metadata
// ---------------------------------------------------------------------------

type ExecSession = {
  socket: net.Socket;
  execId: string;
  containerId: string;
  orgId: string;
  appId: string;
  createdAt: number;
};

const sessions = new Map<string, ExecSession>();

// Clean up stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    // Remove sessions older than 30 minutes or with destroyed sockets
    if (now - session.createdAt > 30 * 60 * 1000 || session.socket.destroyed) {
      session.socket.destroy();
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// ---------------------------------------------------------------------------
// GET — SSE stream for terminal output + initial session setup
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const termGate = await requirePlugin("terminal");
    if (termGate) return termGate;

    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return new Response("Forbidden", { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true },
    });

    if (!app) {
      return new Response("Not found", { status: 404 });
    }

    // Get container from query param, or find the first running container
    const searchParams = request.nextUrl.searchParams;
    let containerId = searchParams.get("container");

    const containers = await listContainers(app.name);
    const runningContainers = containers.filter((c) => c.state === "running");

    if (runningContainers.length === 0) {
      return new Response(
        JSON.stringify({ error: "No running containers found" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!containerId) {
      containerId = runningContainers[0].id;
    }

    // Verify the container belongs to this app
    const container = runningContainers.find((c) => c.id === containerId);
    if (!container) {
      return new Response(
        JSON.stringify({ error: "Container not found or not running" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Create exec instance
    const execId = await createExec(containerId, ["/bin/sh"]);
    const socket = await startExec(execId);

    // No initial command — let the shell start naturally

    // Generate session ID
    const sessionId = crypto.randomUUID();

    // Store the session
    sessions.set(sessionId, {
      socket,
      execId,
      containerId,
      orgId,
      appId,
      createdAt: Date.now(),
    });

    // Create SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Send session info as first event
        try {
          controller.enqueue(
            encoder.encode(
              `event: session\ndata: ${JSON.stringify({ sessionId, containerId, containerName: container.name })}\n\n`,
            ),
          );
        } catch {
          // Controller already closed
          return;
        }

        // Forward socket output to SSE
        socket.on("data", (chunk: Buffer) => {
          try {
            // Send as base64 to handle binary/control chars
            const b64 = chunk.toString("base64");
            controller.enqueue(
              encoder.encode(`event: output\ndata: ${JSON.stringify(b64)}\n\n`),
            );
          } catch {
            // Controller closed
            socket.destroy();
          }
        });

        socket.on("end", () => {
          try {
            controller.enqueue(
              encoder.encode(`event: exit\ndata: ${JSON.stringify({ reason: "exited" })}\n\n`),
            );
            controller.close();
          } catch {
            // Already closed
          }
          sessions.delete(sessionId);
        });

        socket.on("error", (err) => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`,
              ),
            );
            controller.close();
          } catch {
            // Already closed
          }
          sessions.delete(sessionId);
        });

        // Clean up when client disconnects
        request.signal.addEventListener("abort", () => {
          socket.destroy();
          sessions.delete(sessionId);
          try {
            controller.close();
          } catch {
            // Already closed
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Terminal-Session": sessionId,
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error creating terminal session");
  }
}

// ---------------------------------------------------------------------------
// POST — Send input to terminal or resize
// ---------------------------------------------------------------------------

async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const termGate = await requirePlugin("terminal");
    if (termGate) return termGate;

    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const { sessionId, type, data, cols, rows } = body as {
      sessionId: string;
      type: "input" | "resize";
      data?: string;
      cols?: number;
      rows?: number;
    };

    const session = sessions.get(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found or expired" },
        { status: 404 },
      );
    }

    // Verify session belongs to this org and app
    if (session.orgId !== orgId || session.appId !== appId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (session.socket.destroyed) {
      sessions.delete(sessionId);
      return NextResponse.json(
        { error: "Session closed" },
        { status: 410 },
      );
    }

    if (type === "input" && data) {
      // data is base64 encoded from the client
      const buf = Buffer.from(data, "base64");
      session.socket.write(buf);
      return NextResponse.json({ ok: true });
    }

    if (type === "resize" && cols && rows) {
      try {
        await resizeExec(session.execId, cols, rows);
      } catch {
        // Resize can fail if exec has already exited; non-fatal
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  } catch (error) {
    return handleRouteError(error, "Error handling terminal input");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-terminal" });
