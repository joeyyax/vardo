import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema/apps";
import { apps } from "@/lib/db/schema/apps";
import { publishEvent, appChannel } from "@/lib/events";
import { acquireLock } from "@/lib/redis-lock";
import { logger } from "@/lib/logger";
import { eq, and, lt, count } from "drizzle-orm";
import { reconcileActiveCounter, removeFromQueue } from "@/lib/docker/deploy-concurrency";

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

  if (stuck.length === 0) return;

  log.info(`Found ${stuck.length} stuck deployment(s)`);

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
        const app = await db.query.apps.findFirst({
          where: eq(apps.id, deploy.appId),
          columns: { organizationId: true, name: true, displayName: true },
        });
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

  // After sweeping stuck running deploys, reconcile the concurrency counter
  // against the true number of running deployments so the counter doesn't
  // drift if a process crashed mid-deploy without releasing its slot.
  try {
    const [{ value: runningCount }] = await db
      .select({ value: count() })
      .from(deployments)
      .where(eq(deployments.status, "running"));
    await reconcileActiveCounter(runningCount);
  } catch (err) {
    log.warn("Failed to reconcile deploy concurrency counter:", err);
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

      log.info(
        `Cancelled queued deployment ${deploy.id} (app ${deploy.appId}) — stuck in queue for ${queueTimeoutMinutes}m`,
      );
    } catch (err) {
      log.error(`Failed to sweep queued deployment ${deploy.id}:`, err);
    }
  }
}
