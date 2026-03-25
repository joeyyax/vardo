import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { deployProject } from "@/lib/docker/deploy";
import { deployGroup } from "@/lib/docker/deploy-group";
import { createSSEResponse } from "@/lib/api/sse";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// POST /api/v1/organizations/[orgId]/apps/[appId]/deploy
// Returns SSE stream of deploy log lines, final event is the result
async function handler(request: NextRequest, { params }: { params: Promise<{ orgId: string; appId: string }> }) {
  const { orgId, appId } = await params;

  try {
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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

    // Parse optional environmentId, groupEnvironmentId, and deployAll flag from body
    let environmentId: string | undefined;
    let groupEnvironmentId: string | undefined;
    let deployAll = false;
    try {
      const body = await request.json();
      environmentId = body?.environmentId;
      groupEnvironmentId = body?.groupEnvironmentId;
      deployAll = body?.deployAll === true;
    } catch {
      // No body or invalid JSON — deploy to default (production)
    }

    // Group deploy: triggered by deployAll flag or explicit groupEnvironmentId
    if (app.projectId && (deployAll || groupEnvironmentId)) {
      // Group deploy via project
      return createSSEResponse(request, async (sendEvent) => {
        const result = await deployGroup({
          projectId: app.projectId!,
          organizationId: orgId,
          trigger: "manual",
          triggeredBy: org.session.user.id,
          groupEnvironmentId,
          onLog: (appName, line) =>
            sendEvent("log", { app: appName, line }),
          onStage: (appName, stage, status) =>
            sendEvent("stage", { app: appName, stage, status }),
          onTier: (tier, appNames) =>
            sendEvent("tier", { tier, apps: appNames }),
        });
        sendEvent("done", {
          success: result.success,
          results: result.results,
          totalDurationMs: result.totalDurationMs,
        });
      });
    }

    // Single app deploy (deployProject resolves default environment if not specified)
    //
    // NOTE: Do NOT pass request.signal to deployProject. The request signal
    // fires when the SSE connection drops (client navigates away, reconnects,
    // or hits backpressure), which is not the same as the user pressing
    // "abort". Passing it through caused first deploys to report "aborted"
    // because the SSE connection would briefly reset after the build step.
    // Deploys should always run to completion once started.
    return createSSEResponse(request, async (sendEvent) => {
      const result = await deployProject({
        appId: appId,
        organizationId: orgId,
        trigger: "manual",
        triggeredBy: org.session.user.id,
        environmentId,
        onLog: (line) => sendEvent("log", line),
        onStage: (stg, status) => sendEvent("stage", { stage: stg, status }),
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

export const POST = withRateLimit(handler, { tier: "critical", key: "deploy" });
