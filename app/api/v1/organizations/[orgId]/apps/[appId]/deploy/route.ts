import { NextRequest } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { deployGroup } from "@/lib/docker/deploy-group";
import { createSSEResponse } from "@/lib/api/sse";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { refuseSystemManaged } from "@/lib/api/system-managed";

// POST /api/v1/organizations/[orgId]/apps/[appId]/deploy
// Returns SSE stream of deploy log lines, final event is the result
async function handler(request: NextRequest, { params }: { params: Promise<{ orgId: string; appId: string }> }) {
  const { orgId, appId } = await params;

  try {
    const org = await verifyOrgAccess(orgId, "app.deploy");
    if (!org) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: { id: true, name: true, projectId: true, isSystemManaged: true },
    });

    if (!app) {
      return apiError.notFound("app");
    }

    const refused = refuseSystemManaged(app, "deploy");
    if (refused) return refused;

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

    if (app.projectId && (deployAll || groupEnvironmentId)) {
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

    // requestDeploy cancels or waits on an in-progress build.
    // Don't pass request.signal: it fires when SSE drops, not on abort.
    return createSSEResponse(request, async (sendEvent) => {
      const result = await requestDeploy({
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
        status: result.status,
        error: result.error,
        postDeployError: result.postDeployError,
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error deploying app");
  }
}

// Coarse abuse ceiling; requestDeploy already serializes deploys.
export const POST = withRateLimit(handler, { tier: "mutation", key: "deploy" });
