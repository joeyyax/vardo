import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { deployProject } from "@/lib/docker/deploy";
import { deployGroup } from "@/lib/docker/deploy-group";
import { createSSEResponse } from "@/lib/api/sse";
import { rateLimit } from "@/lib/api/rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// POST /api/v1/organizations/[orgId]/apps/[appId]/deploy
// Returns SSE stream of deploy log lines, final event is the result
export async function POST(request: NextRequest, { params }: RouteParams) {
  const limited = rateLimit(request, { key: "deploy", limit: 10, windowMs: 60000 });
  if (limited) return limited;

  try {
    const { orgId, appId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: { id: true, projectId: true },
    });

    if (!app) {
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

    // Check if this app belongs to a project that has group deployments
    if (app.projectId && groupEnvironmentId) {
      // Group deploy via project
      return createSSEResponse(request, async (sendEvent) => {
        const result = await deployGroup({
          projectId: app.projectId!,
          organizationId: orgId,
          trigger: "manual",
          triggeredBy: session.user.id,
          groupEnvironmentId,
          onLog: (appName, line) =>
            sendEvent("log", { app: appName, line }),
          onStage: (appName, stage, status) =>
            sendEvent("stage", { app: appName, stage, status }),
          onTier: (tier, appNames) =>
            sendEvent("tier", { tier, apps: appNames }),
          signal: request.signal,
        });
        sendEvent("done", {
          success: result.success,
          results: result.results,
          totalDurationMs: result.totalDurationMs,
        });
      });
    }

    // Single app deploy (deployProject resolves default environment if not specified)
    return createSSEResponse(request, async (sendEvent) => {
      const result = await deployProject({
        appId: appId,
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
    return handleRouteError(error, "Error deploying app");
  }
}
