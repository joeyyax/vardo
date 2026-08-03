import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema/apps";
import { apps } from "@/lib/db/schema/apps";
import { environments } from "@/lib/db/schema/environments";
import { addEvent } from "@/lib/stream/producer";
import { acquireLock } from "@/lib/redis-lock";
import { logger } from "@/lib/logger";
import { eq, and, lt, gt, or, desc, inArray } from "drizzle-orm";
import { reconcileActiveCounter, reconcileQueue, removeFromQueue } from "@/lib/docker/deploy-concurrency";
import { stopProject } from "@/lib/docker/deploy";
import { appEnvDir } from "@/lib/paths";
import { detectActiveSlot } from "@/lib/docker/slots";
import {
  performRollback,
  sendRollbackNotification,
  slotContainerIds,
  slotIsDown,
} from "@/lib/docker/rollback-monitor";
import {
  evaluateWatch,
  MAX_GRACE_PERIOD_SECONDS,
  type Slot,
} from "./rollback-watch";

const log = logger.child("deploy-sweeper");

const TIMEOUT_MINUTES = Number(process.env.DEPLOY_TIMEOUT_MINUTES) || 15;

/** One rollback attempt per deployment. A failed attempt is not retried. */
const ROLLBACK_ATTEMPT_TTL_MS = MAX_GRACE_PERIOD_SECONDS * 1000;

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

      // Stop orphaned containers left by the crashed deploy process
      const app = appMap.get(deploy.appId);
      if (app) {
        try {
          await stopProject(deploy.appId, app.name);
        } catch {
          // Best effort — containers may not have started
        }
      }

      // Notify real-time UI via org event stream
      if (app) {
        addEvent(app.organizationId, {
          type: "deploy.status",
          title: "Deploy timed out",
          message: `Deployment timed out after ${TIMEOUT_MINUTES} minutes`,
          appId: deploy.appId,
          deploymentId: deploy.id,
          status: "error",
          success: false,
          durationMs,
        }).catch(() => {});
      }

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

      // Notify real-time UI via org event stream
      {
        const app = appMap.get(deploy.appId);
        if (app) {
          addEvent(app.organizationId, {
            type: "deploy.status",
            title: "Queued deploy cancelled",
            message: `Deployment was stuck in queue for ${queueTimeoutMinutes} minutes and was cancelled`,
            appId: deploy.appId,
            deploymentId: deploy.id,
            status: "cancelled",
            success: false,
            durationMs,
          }).catch(() => {});
        }
      }

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

// ---------------------------------------------------------------------------
// Auto-rollback grace period
// ---------------------------------------------------------------------------

type RollbackCandidate = {
  deploymentId: string;
  appId: string;
  slot: string | null;
  finishedAt: Date | null;
  environmentId: string | null;
  appName: string;
  appStatus: string;
  organizationId: string;
  gracePeriodSeconds: number | null;
};

/**
 * Roll back apps whose containers stopped inside their post-deploy grace
 * period.
 *
 * The window is rebuilt from the deployment rows on every pass, so a Vardo
 * restart mid-window resumes the watch. Every guard below reads live state at
 * the moment it runs — nothing is decided in advance.
 */
export async function sweepRollbackWatches(): Promise<void> {
  const now = Date.now();
  const earliest = new Date(now - MAX_GRACE_PERIOD_SECONDS * 1000);

  const candidates: RollbackCandidate[] = await db
    .select({
      deploymentId: deployments.id,
      appId: deployments.appId,
      slot: deployments.slot,
      finishedAt: deployments.finishedAt,
      environmentId: deployments.environmentId,
      appName: apps.name,
      appStatus: apps.status,
      organizationId: apps.organizationId,
      gracePeriodSeconds: apps.rollbackGracePeriod,
    })
    .from(deployments)
    .innerJoin(apps, eq(deployments.appId, apps.id))
    .where(
      and(
        eq(deployments.status, "success"),
        eq(apps.autoRollback, true),
        gt(deployments.finishedAt, earliest),
      ),
    );

  for (const candidate of candidates) {
    try {
      const latest = await db.query.deployments.findFirst({
        where: eq(deployments.appId, candidate.appId),
        orderBy: [desc(deployments.startedAt)],
        columns: { id: true },
      });

      const verdict = evaluateWatch(
        {
          appName: candidate.appName,
          appStatus: candidate.appStatus,
          slot: candidate.slot,
          finishedAt: candidate.finishedAt,
          gracePeriodSeconds: candidate.gracePeriodSeconds,
          superseded: latest?.id !== candidate.deploymentId,
        },
        now,
      );
      if (!verdict.watch) continue;

      await checkRollbackWatch(candidate, verdict.slot, verdict.standbySlot);
    } catch (err) {
      log.error(`Rollback watch failed for deployment ${candidate.deploymentId}:`, err);
    }
  }
}

async function checkRollbackWatch(
  candidate: RollbackCandidate,
  slot: Slot,
  standbySlot: Slot,
): Promise<void> {
  const envName = await envNameFor(candidate.environmentId);
  const appDir = appEnvDir(candidate.appName, envName);
  const projectPrefix = `${candidate.appName}-${envName}`;

  // Only act while the deploy being watched is still the one serving. An
  // instant rollback or a manual slot change since the deploy makes this stale.
  const activeSlot = await detectActiveSlot(appDir, projectPrefix).catch(() => null);
  if (activeSlot !== slot) return;

  const down = await slotIsDown(`${projectPrefix}-${slot}`);
  if (down !== true) return; // still serving, or Docker unreachable

  // Tearing down the only slot an app has leaves it with nothing. Say so once.
  const standby = await slotContainerIds(`${projectPrefix}-${standbySlot}`, true);
  if (standby === null) return;
  if (standby.length === 0) {
    if (await acquireLock(`rollback:no-standby:${candidate.deploymentId}`, ROLLBACK_ATTEMPT_TTL_MS)) {
      log.error(
        `${candidate.appName} stopped within its grace period but ${standbySlot} has no containers to roll back to`,
      );
      await sendRollbackNotification(
        candidate.organizationId,
        candidate.appId,
        candidate.appName,
        false,
        `Containers stopped within the post-deploy grace period, but the ${standbySlot} slot has nothing to roll back to. Manual intervention required.`,
      );
    }
    return;
  }

  // One attempt per deployment, across every instance. A failed restore is
  // reported rather than retried against a system that has since moved.
  if (!(await acquireLock(`rollback:watch:${candidate.deploymentId}`, ROLLBACK_ATTEMPT_TTL_MS))) return;

  log.info(`${candidate.appName} stopped within its grace period — rolling back ${slot} to ${standbySlot}`);

  await performRollback({
    appId: candidate.appId,
    appName: candidate.appName,
    organizationId: candidate.organizationId,
    deploymentId: candidate.deploymentId,
    currentSlot: slot,
    previousSlot: standbySlot,
    envName,
  });
}

/** Mirrors the deploy's own resolution: the environment's name, else production. */
async function envNameFor(environmentId: string | null): Promise<string> {
  if (!environmentId) return "production";
  const env = await db.query.environments.findFirst({
    where: eq(environments.id, environmentId),
    columns: { name: true },
  });
  return env?.name ?? "production";
}
