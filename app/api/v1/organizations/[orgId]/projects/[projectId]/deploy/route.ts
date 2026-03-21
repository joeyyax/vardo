import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { projects, environments } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { deployProject } from "@/lib/docker/deploy";
import { deployGroup } from "@/lib/docker/deploy-group";
import { createSSEResponse } from "@/lib/api/sse";

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

    // Parse optional environmentId and groupEnvironmentId from body
    let environmentId: string | undefined;
    let groupEnvironmentId: string | undefined;
    try {
      const body = await request.json();
      environmentId = body?.environmentId;
      groupEnvironmentId = body?.groupEnvironmentId;
    } catch {
      // No body or invalid JSON — deploy to default (production)
    }

    // Check if this project has children (is a parent/group project)
    const firstChild = await db.query.projects.findFirst({
      where: eq(projects.parentId, projectId),
      columns: { id: true },
    });

    if (firstChild) {
      // Parent project — deploy all children
      return createSSEResponse(request, async (sendEvent) => {
        const result = await deployGroup({
          parentProjectId: projectId,
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
        });
        sendEvent("done", {
          success: result.success,
          results: result.results,
          totalDurationMs: result.totalDurationMs,
        });
      });
    }

    // Single project deploy
    // Default to production environment
    if (!environmentId) {
      const defaultEnv = await db.query.environments.findFirst({
        where: and(
          eq(environments.projectId, projectId),
          eq(environments.isDefault, true),
        ),
        columns: { id: true },
      });
      environmentId = defaultEnv?.id;
    }

    return createSSEResponse(request, async (sendEvent) => {
      const result = await deployProject({
        projectId,
        organizationId: orgId,
        trigger: "manual",
        triggeredBy: session.user.id,
        environmentId,
        onLog: (line) => sendEvent("log", line),
        onStage: (stg, status) => sendEvent("stage", { stage: stg, status }),
        signal: request.signal,
      });
      sendEvent("done", {
        deploymentId: result.deploymentId,
        success: result.success,
        durationMs: result.durationMs,
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error deploying project");
  }
}
