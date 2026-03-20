import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { deployProject } from "@/lib/docker/deploy";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// POST /api/v1/organizations/[orgId]/projects/[projectId]/deploy
// Returns SSE stream of deploy log lines, final event is the result
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.organizationId, orgId)
      ),
      columns: { id: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        function sendEvent(event: string, data: unknown) {
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
            );
          } catch { /* stream closed */ }
        }

        deployProject({
          projectId,
          organizationId: orgId,
          trigger: "manual",
          triggeredBy: session.user.id,
          onLog: (line) => sendEvent("log", line),
          onStage: (stage, status) => sendEvent("stage", { stage, status }),
        }).then((result) => {
          sendEvent("done", {
            deploymentId: result.deploymentId,
            success: result.success,
            durationMs: result.durationMs,
          });
          try { controller.close(); } catch { /* already closed */ }
        }).catch((err) => {
          sendEvent("error", { message: err instanceof Error ? err.message : "Deploy failed" });
          try { controller.close(); } catch { /* already closed */ }
        });

        request.signal.addEventListener("abort", () => {
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
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deploying project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
