import { NextRequest } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { enqueueDeploy } from "@/lib/deploy/queue";
import { enqueueGroupDeploy, tailGroupJob } from "@/lib/deploy/group-job";
import { tailDeployment } from "@/lib/stream/deploy-tail";
import { createSSEResponse } from "@/lib/api/sse";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { refuseSystemManaged } from "@/lib/api/system-managed";
import type { RebuildMode } from "@/lib/docker/build-key";

// POST /api/v1/organizations/[orgId]/apps/[appId]/deploy
// Queues the deploy and returns an SSE stream of its log lines; the final event is the result.
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
    let rebuild: RebuildMode | undefined;
    try {
      const body = await request.json();
      environmentId = body?.environmentId;
      groupEnvironmentId = body?.groupEnvironmentId;
      deployAll = body?.deployAll === true;
      rebuild = body?.rebuild === "force" || body?.rebuild === "no-cache" ? body.rebuild : undefined;
    } catch {
      // No body or invalid JSON — deploy to default (production)
    }

    if (app.projectId && (deployAll || groupEnvironmentId)) {
      const jobId = await enqueueGroupDeploy({
        projectId: app.projectId,
        organizationId: orgId,
        trigger: "manual",
        triggeredBy: org.session.user.id,
        groupEnvironmentId,
      });
      return createSSEResponse(request, (sendEvent) => tailGroupJob(jobId, sendEvent, { signal: request.signal }));
    }

    const { id } = await enqueueDeploy({
      appId,
      trigger: "manual",
      triggeredBy: org.session.user.id,
      environmentId,
      rebuild,
    });

    // The deploy runs in its executor; a dropped stream stops only the tail.
    return createSSEResponse(request, async (sendEvent) => {
      const result = await tailDeployment(
        id,
        {
          onLog: (line) => sendEvent("log", line),
          onStage: (stg, status, meta) => sendEvent("stage", { stage: stg, status, streamId: meta.streamId }),
          onWait: (wait) => sendEvent("wait", { deploymentId: id, ...wait }),
          onStatus: (status) => sendEvent("status", { deploymentId: id, status }),
        },
        { signal: request.signal },
      );
      if (!result) return;
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

// Coarse abuse ceiling; the queue serializes deploys per app.
export const POST = withRateLimit(handler, { tier: "mutation", key: "deploy" });
