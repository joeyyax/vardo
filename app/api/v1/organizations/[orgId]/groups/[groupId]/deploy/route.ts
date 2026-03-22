import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { groups } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { deployGroup } from "@/lib/docker/deploy-group";

type RouteParams = {
  params: Promise<{ orgId: string; groupId: string }>;
};

// POST /api/v1/organizations/[orgId]/groups/[groupId]/deploy
// Returns SSE stream of deploy log lines with per-project progress
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, groupId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const group = await db.query.groups.findFirst({
      where: and(eq(groups.id, groupId), eq(groups.organizationId, orgId)),
      columns: { id: true },
    });

    if (!group) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Optional: deploy to a specific group environment
    const body = await request.json().catch(() => ({}));
    const groupEnvironmentId = body.groupEnvironmentId as string | undefined;

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

        deployGroup({
          groupId,
          organizationId: orgId,
          trigger: "manual",
          triggeredBy: session.user.id,
          groupEnvironmentId,
          onLog: (projectName, line) =>
            sendEvent("log", { project: projectName, line }),
          onStage: (projectName, stage, status) =>
            sendEvent("stage", { project: projectName, stage, status }),
          onTier: (tier, projectNames) =>
            sendEvent("tier", { tier, projects: projectNames }),
          signal: request.signal,
        })
          .then((result) => {
            sendEvent("done", {
              success: result.success,
              results: result.results,
              totalDurationMs: result.totalDurationMs,
            });
            try {
              controller.close();
            } catch { /* already closed */ }
          })
          .catch((err) => {
            sendEvent("error", {
              message: err instanceof Error ? err.message : "Group deploy failed",
            });
            try {
              controller.close();
            } catch { /* already closed */ }
          });

        request.signal.addEventListener("abort", () => {
          try {
            controller.close();
          } catch { /* already closed */ }
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
    console.error("Error deploying group:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
