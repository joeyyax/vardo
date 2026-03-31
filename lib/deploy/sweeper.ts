import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema/apps";
import { apps } from "@/lib/db/schema/apps";
import { publishEvent, appChannel } from "@/lib/events";
import { acquireLock } from "@/lib/redis-lock";
import { logger } from "@/lib/logger";
import { eq, and, lt, or, inArray } from "drizzle-orm";
import { reconcileActiveCounter, reconcileQueue, removeFromQueue } from "@/lib/docker/deploy-concurrency";

const log = logger.child("deploy-sweeper");

const TIMEOUT_MINUTES = Number(process.env.DEPLOY_TIMEOUT_MINUTES) || 15;

/**
 * Find deployments stuck in "running" status for longer than the timeout
 * threshold and mark them as failed.
 */
export async function sweepStuckDeployments(): Promise<void> {
  const cutoff = new Date(Date.now() - TIMEOUT_MINUTES * 60_000);

  const stuck = await db
    .select({
      id: deployments.id,
      appId: deployments.appId,
      log: deployments.log,
      startedAt: deployments.startedAt,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.status, "running"),
        lt(deployments.startedAt, cutoff),
      ),
    );

  // Always reconcile the concurrency counter — the counter can drift whenever
  // a process crashes mid-deploy, not just when a stuck deployment is found.
  // Running this unconditionally ensures the counter self-heals even when all
  // deploys finish cleanly but a release failed silently.
  try {
    const activeDeployments = await db
      .select({ id: deployments.id, status: deployments.status })
      .from(deployments)
      .where(or(eq(deployments.status, "running"), eq(deployments.status, "queued")));

    const runningCount = activeDeployments.filter((d) => d.status === "running").length;
    await reconcileActiveCounter(runningCount);

    // Reconcile the Redis queue against DB state — removes orphaned entries left
    // by a partial Redis failure (rpush succeeded but subsequent eval threw).
    const activeIds = new Set(activeDeployments.map((d) => d.id));
    await reconcileQueue(activeIds);
  } catch (err) {
    log.warn("Failed to reconcile deploy concurrency state:", err);
  }

  if (stuck.length === 0) return;

  log.info(`Found ${stuck.length} stuck deployment(s)`);

  // Batch-fetch app metadata for all stuck deployments up front
  const stuckAppIds = [...new Set(stuck.map((d) => d.appId))];
  const appRows = await db
    .select({
      id: apps.id,
      organizationId: apps.organizationId,
      name: apps.name,
      displayName: apps.displayName,
    })
    .from(apps)
    .where(inArray(apps.id, stuckAppIds));
  const appMap = new Map(appRows.map((a) => [a.id, a]));

  for (const deploy of stuck) {
    // Distributed lock prevents double-processing across instances
    const lockKey = `sweep:deploy:${deploy.id}`;
    const acquired = await acquireLock(lockKey, 60_000);
    if (!acquired) continue;

    try {
      const now = new Date();
      const timeoutLine = `[${now.toISOString()}] [TIMEOUT] Deployment timed out after ${TIMEOUT_MINUTES} minutes`;
      const updatedLog = deploy.log
        ? `${deploy.log}\n${timeoutLine}`
        : timeoutLine;

      const durationMs = now.getTime() - new Date(deploy.startedAt).getTime();

      await db
        .update(deployments)
        .set({
          status: "failed",
          log: updatedLog,
          finishedAt: now,
          durationMs,
        })
        .where(
          and(eq(deployments.id, deploy.id), eq(deployments.status, "running")),
        );

      // Reset the app status if it's still "deploying"
      await db
        .update(apps)
        .set({ status: "stopped", updatedAt: now })
        .where(
          and(eq(apps.id, deploy.appId), eq(apps.status, "deploying")),
        );

      // Notify any connected SSE clients
      publishEvent(appChannel(deploy.appId), {
        event: "deploy:complete",
        status: "error",
        deploymentId: deploy.id,
        success: false,
        durationMs,
      }).catch(() => {});

      // Emit notification
      try {
        const { emit } = await import("@/lib/notifications/dispatch");
        const app = appMap.get(deploy.appId);
        if (app) {
          const projectName = app.displayName || app.name;
          emit(app.organizationId, {
            type: "deploy.failed",
            title: `Deploy timed out: ${projectName}`,
            message: `Deployment exceeded the ${TIMEOUT_MINUTES}-minute timeout and was marked as failed.`,
            projectName,
            appId: deploy.appId,
            deploymentId: deploy.id,
            errorMessage: `Deployment timed out after ${TIMEOUT_MINUTES} minutes`,
          });
        }
      } catch {
        // notification failure is non-fatal
      }

      log.info(
        `Marked deployment ${deploy.id} (app ${deploy.appId}) as failed — timed out after ${TIMEOUT_MINUTES}m`,
      );
    } catch (err) {
      log.error(`Failed to sweep deployment ${deploy.id}:`, err);
    }
  }

}

/**
 * Find deployments stuck in "queued" status for longer than the timeout
 * threshold and mark them as cancelled.
 *
 * A deployment is created with status "queued" and only transitions to
 * "running" once it acquires a concurrency slot. If the process that was
 * waiting for a slot crashes, the DB record stays "queued" indefinitely.
 * This sweep catches those orphans.
 */
export async function sweepStuckQueuedDeployments(): Promise<void> {
  // Give queued deploys a bit more runway than running ones — they may be
  // waiting in a long queue. Use 2× the running timeout as a reasonable bound.
  const queueTimeoutMinutes = TIMEOUT_MINUTES * 2;
  const cutoff = new Date(Date.now() - queueTimeoutMinutes * 60_000);

  const stuck = await db
    .select({
      id: deployments.id,
      appId: deployments.appId,
      startedAt: deployments.startedAt,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.status, "queued"),
        lt(deployments.startedAt, cutoff),
      ),
    );

  if (stuck.length === 0) return;

  log.info(`Found ${stuck.length} stuck queued deployment(s)`);

  // Batch-fetch app metadata for all stuck deployments up front
  const stuckAppIds = [...new Set(stuck.map((d) => d.appId))];
  const appRows = await db
    .select({
      id: apps.id,
      organizationId: apps.organizationId,
      name: apps.name,
      displayName: apps.displayName,
    })
    .from(apps)
    .where(inArray(apps.id, stuckAppIds));
  const appMap = new Map(appRows.map((a) => [a.id, a]));

  for (const deploy of stuck) {
    const lockKey = `sweep:queued:${deploy.id}`;
    const acquired = await acquireLock(lockKey, 60_000);
    if (!acquired) continue;

    try {
      const now = new Date();
      const durationMs = now.getTime() - new Date(deploy.startedAt).getTime();
      const timeoutLine = `[${now.toISOString()}] [TIMEOUT] Deployment was stuck in queue for ${queueTimeoutMinutes} minutes and was cancelled`;

      await db
        .update(deployments)
        .set({
          status: "cancelled",
          log: timeoutLine,
          finishedAt: now,
          durationMs,
        })
        .where(
          and(eq(deployments.id, deploy.id), eq(deployments.status, "queued")),
        );

      // Remove from the Redis queue in case the entry is still there
      await removeFromQueue(deploy.id).catch(() => {});

      // Notify connected SSE clients so the UI updates in real-time
      publishEvent(appChannel(deploy.appId), {
        event: "deploy:complete",
        status: "cancelled",
        deploymentId: deploy.id,
        success: false,
        durationMs,
      }).catch(() => {});

      // Emit notification
      try {
        const { emit } = await import("@/lib/notifications/dispatch");
        const app = appMap.get(deploy.appId);
        if (app) {
          const projectName = app.displayName || app.name;
          emit(app.organizationId, {
            type: "deploy.failed",
            title: `Deploy cancelled: ${projectName}`,
            message: `Deployment was stuck in the queue for ${queueTimeoutMinutes} minutes and was cancelled.`,
            projectName,
            appId: deploy.appId,
            deploymentId: deploy.id,
            errorMessage: `Deployment stuck in queue for ${queueTimeoutMinutes} minutes`,
          });
        }
      } catch {
        // notification failure is non-fatal
      }

      log.info(
        `Cancelled queued deployment ${deploy.id} (app ${deploy.appId}) — stuck in queue for ${queueTimeoutMinutes}m`,
      );
    } catch (err) {
      log.error(`Failed to sweep queued deployment ${deploy.id}:`, err);
    }
  }
}
