import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { subscribe, appChannel } from "@/lib/events";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/deploy/stream
// SSE stream of deploy log lines and stage transitions via Redis pub/sub.
// Clients connect here to follow an in-progress deployment in real time.
// On connect, backfills logs from the running deployment record.
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return new Response("Forbidden", { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });

    if (!app) {
      return new Response("Not found", { status: 404 });
    }

    const runningDeploy = await db.query.deployments.findFirst({
      where: and(eq(deployments.appId, appId), eq(deployments.status, "running")),
      columns: { id: true, log: true },
      orderBy: [desc(deployments.startedAt)],
    });

    const encoder = new TextEncoder();

    // Subscribe before constructing the stream so that a cap error is caught
    // by the outer try/catch and returned as a 503 instead of leaving the
    // client connected to a stream that never delivers events.
    let unsubscribe: () => void;
    try {
      unsubscribe = subscribe(appChannel(appId), (data) => {
        const event = data.event as string;
        if (event === "deploy:log") {
          send("log", { deploymentId: data.deploymentId, message: data.message });
        } else if (event === "deploy:stage") {
          send("stage", { deploymentId: data.deploymentId, stage: data.stage, status: data.status });
        } else if (event === "deploy:complete") {
          send("done", { deploymentId: data.deploymentId, success: data.success, durationMs: data.durationMs, status: data.status });
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Subscriber cap reached";
      return new Response(JSON.stringify({ error: msg }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    // `send` and `controller` are assigned synchronously inside ReadableStream.start
    // before any Redis messages can arrive (async), so the closure above is safe.
    let controller!: ReadableStreamDefaultController;
    let send!: (event: string, data: unknown) => void;

    const stream = new ReadableStream({
      start(ctrl) {
        controller = ctrl;

        send = (event: string, data: unknown) => {
          try {
            if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch { /* client disconnected */ }
        };

        if (runningDeploy) {
          send("backfill-start", { deploymentId: runningDeploy.id });
          if (runningDeploy.log) {
            for (const line of runningDeploy.log.split("\n")) {
              if (line) send("log", { deploymentId: runningDeploy.id, message: line });
            }
          }
          send("backfill-end", { deploymentId: runningDeploy.id });
        }

        const keepalive = setInterval(() => {
          try { controller.enqueue(encoder.encode(": keepalive\n\n")); }
          catch { clearInterval(keepalive); }
        }, 30000);

        // Re-check after subscription is live to close the backfill race:
        // if deploy finished between the initial query and subscribe(), we'd
        // never receive the done event. Catch it here.
        if (runningDeploy) {
          db.query.deployments.findFirst({
            where: eq(deployments.id, runningDeploy.id),
            columns: { id: true, status: true },
          }).then((latest) => {
            if (latest && latest.status !== "running") {
              send("done", { deploymentId: latest.id, success: latest.status === "success", status: latest.status });
              cleanup();
              try { controller.close(); } catch { /* already closed */ }
            }
          }).catch(() => { /* best-effort */ });
        }

        const timeout = setTimeout(() => {
          send("timeout", { message: "Stream timed out" });
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        }, 10 * 60 * 1000);

        function cleanup() {
          clearInterval(keepalive);
          clearTimeout(timeout);
          unsubscribe();
        }

        request.signal.addEventListener("abort", () => {
          cleanup();
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
    return handleRouteError(error, "Error streaming deploy logs");
  }
}
