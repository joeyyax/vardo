import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { deployments, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { publishKillSignal, clearActiveInRedis, deployRegistration } from "@/lib/docker/deploy-cancel";
import { addEvent } from "@/lib/stream/producer";
import { releaseConcurrencySlot, removeFromQueue } from "@/lib/docker/deploy-concurrency";
// Container cleanup for force-cancelled deploys is handled by the sweeper
// (lib/deploy/sweeper.ts), which can safely resolve the correct slot.

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; deploymentId: string }>;
};

/** How long a signalled deploy has to write its own cancelled row before we do. */
const UNRESPONSIVE_GRACE_MS = 60_000;

/**
 * Last resort for a deploy whose process died holding the record.
 *
 * A live engine finishes the phase it is in and writes the row itself, which can
 * take minutes on a build — so this only fires once the registry no longer names
 * the deploy, meaning nothing is running it.
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

  // Release the concurrency slot, clear the active deploy marker, and remove
  // from queue so the next deploy can start immediately.
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
      // The engine stops at the end of the phase it is in and writes the row
      // itself. Marking it cancelled here is what let a later success overwrite
      // the cancel and made the button lie.
      await publishKillSignal(deploymentId);
      forceCancel(deploymentId, appId, orgId).catch(() => {});
      return NextResponse.json({ ok: true, cancelling: true });
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
