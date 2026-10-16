import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { deployments, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requestCancel } from "@/lib/deploy/queue";
import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; deploymentId: string }>;
};

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/deployments/[deploymentId]
// Cancel a queued or running deployment. A running one stops at its next safe point; deploy-sweep covers a dead executor.
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, deploymentId } = await params;

    const org = await verifyOrgAccess(orgId, "app.deploy");
    if (!org) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });

    if (!app) {
      return apiError.notFound("app");
    }

    const deployment = await db.query.deployments.findFirst({
      where: and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)),
      columns: { id: true, status: true, trigger: true, request: true },
    });

    if (!deployment) {
      return apiError.notFound("deployment");
    }

    // Instant and auto-rollbacks run in-process outside the queue and never read the cancel flag.
    if (deployment.status === "running" && deployment.trigger === "rollback" && !deployment.request?.rollback) {
      return NextResponse.json({ error: "A rollback in progress can't be cancelled. It finishes on its own." }, { status: 409 });
    }

    const outcome = await requestCancel(deploymentId, "user");
    if (outcome === "inactive") {
      return NextResponse.json(
        { error: "Only queued or running deployments can be cancelled" },
        { status: 409 },
      );
    }
    return NextResponse.json(outcome === "cancelled" ? { ok: true } : { ok: true, cancelling: true });
  } catch (error) {
    return handleRouteError(error, "Error cancelling deployment");
  }
}

export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "apps-deployments" });
