import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { deployments, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { publishKillSignal, clearActiveInRedis, deployRegistration } from "@/lib/docker/deploy-cancel";
import { addEvent } from "@/lib/stream/producer";
import { releaseConcurrencySlot, removeFromQueue } from "@/lib/docker/deploy-concurrency";
// The sweeper (lib/deploy/sweeper.ts) cleans up force-cancelled containers.

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; deploymentId: string }>;
};

/** How long a signalled deploy has to write its own cancelled row before it's forced. */
const UNRESPONSIVE_GRACE_MS = 60_000;

/**
 * Last resort for a deploy whose process died holding the record.
 * Fires only once the registry no longer names the deploy.
 */
async function forceCancel(deploymentId: string, appId: string, orgId: string): Promise<void> {
  await new Promise((r) => setTimeout(r, UNRESPONSIVE_GRACE_MS));

  if ((await deployRegistration(appId, deploymentId)) !== "gone") return;

  const deploy = await db.query.deployments.findFirst({
    where: and(eq(deployments.id, deploymentId), eq(deployments.status, "running")),
    columns: { id: true, startedAt: true, log: true, environmentId: true },
  });

  if (!deploy) return; // already handled by the deploy process

  const now = new Date();
  const durationMs = now.getTime() - new Date(deploy.startedAt).getTime();
  const cancelLine = `\n[${now.toISOString()}] [CANCELLED] Force-cancelled by user (deploy process unresponsive)`;

  await db
    .update(deployments)
    .set({
      status: "cancelled",
      log: (deploy.log ?? "") + cancelLine,
      finishedAt: now,
      durationMs,
    })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.status, "running")));

  await db
    .update(apps)
    .set(statusChange("stopped", now))
    .where(and(eq(apps.id, appId), eq(apps.status, "deploying")));

  // Release the slot, clear the active marker and dequeue.
  await clearActiveInRedis(appId, deploymentId).catch(() => {});
  await releaseConcurrencySlot(deploymentId).catch(() => {});
  await removeFromQueue(deploymentId).catch(() => {});

  addEvent(orgId, {
    type: "deploy.status",
    title: "Deploy force-cancelled",
    message: "Force-cancelled by user (deploy process unresponsive)",
    appId,
    deploymentId,
    status: "cancelled",
    success: false,
    durationMs,
  }).catch(() => {});
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/deployments/[deploymentId]
// Cancel a queued or running deployment.
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
      columns: { id: true, status: true },
    });

    if (!deployment) {
      return apiError.notFound("deployment");
    }

    if (deployment.status !== "queued" && deployment.status !== "running") {
      return NextResponse.json(
        { error: "Only queued or running deployments can be cancelled" },
        { status: 409 },
      );
    }

    if (deployment.status === "running") {
      // The engine writes the cancelled row itself at the end of its phase.
      await publishKillSignal(deploymentId);
      forceCancel(deploymentId, appId, orgId).catch(() => {});
      return NextResponse.json({ ok: true, cancelling: true });
    }

    // Queued deployments have not started yet — update the DB directly.
    await db
      .update(deployments)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    // Remove from the concurrency queue.
    await removeFromQueue(deploymentId).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error cancelling deployment");
  }
}

export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "apps-deployments" });
