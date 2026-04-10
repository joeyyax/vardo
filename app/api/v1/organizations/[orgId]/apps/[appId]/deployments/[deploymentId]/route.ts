import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { deployments, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { publishKillSignal } from "@/lib/docker/deploy-cancel";
import { addEvent } from "@/lib/stream/producer";
import { releaseConcurrencySlot, removeFromQueue } from "@/lib/docker/deploy-concurrency";
// Container cleanup for force-cancelled deploys is handled by the sweeper
// (lib/deploy/sweeper.ts), which can safely resolve the correct slot.

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; deploymentId: string }>;
};

/**
 * After publishing a kill signal, wait briefly for the deploy process to
 * self-cancel. If it doesn't respond (crashed process, stuck subprocess),
 * force-mark the deployment as cancelled, stop any running containers,
 * and update the UI.
 */
async function forceCancel(deploymentId: string, appId: string, orgId: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 5_000));

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
    .set({ status: "stopped", updatedAt: now })
    .where(and(eq(apps.id, appId), eq(apps.status, "deploying")));

  // Release the concurrency slot and remove from queue so the next deploy
  // can start immediately instead of waiting for the sweeper to reconcile.
  await releaseConcurrencySlot().catch(() => {});
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
// Cancel a queued or running deployment
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, deploymentId } = await params;

    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const deployment = await db.query.deployments.findFirst({
      where: and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)),
      columns: { id: true, status: true },
    });

    if (!deployment) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (deployment.status !== "queued" && deployment.status !== "running") {
      return NextResponse.json(
        { error: "Only queued or running deployments can be cancelled" },
        { status: 409 },
      );
    }

    if (deployment.status === "running") {
      // Signal the running deploy process to abort at the next stage boundary.
      await publishKillSignal(deploymentId);
      // If the deploy process doesn't respond within 5s (crashed, stuck subprocess),
      // force-mark it as cancelled so the UI isn't stuck forever.
      forceCancel(deploymentId, appId, orgId).catch(() => {});
      return NextResponse.json({ ok: true });
    }

    // Queued deployments have not started yet — update the DB directly.
    await db
      .update(deployments)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    // Remove from the concurrency queue so it doesn't block other deploys.
    await removeFromQueue(deploymentId).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error cancelling deployment");
  }
}

export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "apps-deployments" });
