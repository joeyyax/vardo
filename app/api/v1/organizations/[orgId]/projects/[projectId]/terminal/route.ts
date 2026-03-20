import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { listContainers } from "@/lib/docker/client";
import { createExec, startExec, resizeExec } from "@/lib/docker/exec";
import net from "node:net";

// ---------------------------------------------------------------------------
// Session store — maps sessionId to exec socket and metadata
// ---------------------------------------------------------------------------

type ExecSession = {
  socket: net.Socket;
  execId: string;
  containerId: string;
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
  params: Promise<{ orgId: string; projectId: string }>;
};

// ---------------------------------------------------------------------------
// GET — SSE stream for terminal output + initial session setup
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return new Response("Forbidden", { status: 403 });
    }

    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true, name: true },
    });

    if (!project) {
      return new Response("Not found", { status: 404 });
    }

    // Get container from query param, or find the first running container
    const searchParams = request.nextUrl.searchParams;
    let containerId = searchParams.get("container");

    const containers = await listContainers(project.name);
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

    // Verify the container belongs to this project
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
    if (error instanceof Error && error.message === "Unauthorized") {
      return new Response("Unauthorized", { status: 401 });
    }
    console.error("Error creating terminal session:", error);
    return new Response("Internal server error", { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST — Send input to terminal or resize
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error handling terminal input:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
