import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema/apps";
import { apps } from "@/lib/db/schema/apps";
import { environments } from "@/lib/db/schema/environments";
import { addEvent } from "@/lib/stream/producer";
import { acquireLock } from "@/lib/redis-lock";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { eq, and, lt, gt, desc, inArray } from "drizzle-orm";
import { reconcileActiveCounter, reconcileQueue, removeFromQueue } from "@/lib/docker/deploy-concurrency";
import { stopProject } from "@/lib/docker/deploy";
import { publishKillSignal } from "@/lib/docker/deploy-cancel";
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

/** Written by deploy-cancel for as long as a deploy owns the app. */
const activeDeployKey = (appId: string) => `deploy:active:${appId}`;

/** When this sweep first saw a deployment in "running". */
const runningSinceKey = (deploymentId: string) => `deploy:sweep:running-since:${deploymentId}`;

/** Outlives the budget by a wide margin — an expired mark only restarts the clock. */
const RUNNING_MARK_TTL_MS = TIMEOUT_MINUTES * 60_000 * 4;

/** Rate-limits the "still alive" log line to once per timeout budget. */
const ABORT_LOG_TTL_MS = TIMEOUT_MINUTES * 60_000;

type ActiveDeployEntry = { deploymentId: string; stage?: string };

/**
 * Who owns `deploy:active:{appId}` right now.
 *
 * `known: false` covers an unreachable Redis and an unparseable entry alike.
 * Callers must read it as "unknown", never as "nothing is running" — a Redis
 * blip that reads as "dead" turns this sweep into a fleet-wide outage.
 */
type Liveness = { known: true; active: ActiveDeployEntry | null } | { known: false };

async function readActiveDeploy(appId: string): Promise<Liveness> {
  let raw: string | null;
  try {
    raw = await redis.get(activeDeployKey(appId));
  } catch (err) {
    log.warn(`Could not read the active-deploy key for app ${appId}:`, err);
    return { known: false };
  }

  if (raw === null) return { known: true, active: null };

  try {
    const parsed = JSON.parse(raw) as ActiveDeployEntry;
    if (typeof parsed?.deploymentId !== "string") return { known: false };
    return { known: true, active: parsed };
  } catch {
    log.warn(`Unparseable active-deploy entry for app ${appId} — treating as unknown`);
    return { known: false };
  }
}

/**
 * How long this sweep has observed a deployment in "running", or null when
 * Redis could not answer.
 *
 * `deployments.startedAt` is stamped at INSERT while the row is still queued and
 * is never re-stamped, so it measures time since enqueue — up to 9 minutes of
 * which can be spent waiting for a concurrency slot. Marking the row on first
 * sight is the only running-clock available without a new column.
 */
async function observedRunningMs(deploymentId: string, now: number): Promise<number | null> {
  const key = runningSinceKey(deploymentId);
  try {
    const claimed = await redis.set(key, String(now), "PX", RUNNING_MARK_TTL_MS, "NX");
    if (claimed === "OK") return 0;

    const raw = await redis.get(key);
    const since = raw === null ? now : Number(raw);
    if (!Number.isFinite(since)) return 0;
    return Math.max(0, now - since);
  } catch (err) {
    log.warn(`Could not read the running-since mark for deployment ${deploymentId}:`, err);
    return null;
  }
}

/** Stop a still-live deploy through its own cancellation path. */
async function requestDeployAbort(deploymentId: string): Promise<void> {
  try {
    await publishKillSignal(deploymentId);
  } catch (err) {
    log.warn(`Could not signal deployment ${deploymentId} to cancel:`, err);
  }
}

/**
 * Take the dead deploy's environment down, and only when nothing in it is
 * serving.
 *
 * A deploy tears the previous slot down before starting its own, so the slot a
 * timed-out deploy left behind is usually the only one an environment has.
 * Stopping it because a deploy record aged out is an outage, not a cleanup —
 * so the environment is only cleared once Docker confirms it serves nothing.
 * Every probe failure reads as "unknown" and leaves the containers alone.
 */
async function stopDeadDeployEnvironment(
  appId: string,
  appName: string,
  envName: string,
): Promise<void> {
  const prefix = `${appName}-${envName}`;
  const activeSlot = await detectActiveSlot(appEnvDir(appName, envName), prefix).catch(() => null);
  const project = activeSlot ? `${prefix}-${activeSlot}` : prefix;

  const down = await slotIsDown(project);
  if (down !== true) return; // still serving, or Docker unreachable

  await stopProject(appId, appName, envName);
}

/**
 * Fail deployments that have been running past the timeout budget.
 *
 * The budget is measured from when this sweep first saw the deployment running,
 * not from its enqueue time, and no deployment is touched while Redis still
 * reports a deploy holding the app. Anything Redis or Docker cannot answer is
 * left alone until the next pass.
 */
export async function sweepStuckDeployments(): Promise<void> {
  const running = await db
    .select({
      id: deployments.id,
      appId: deployments.appId,
      log: deployments.log,
      environmentId: deployments.environmentId,
    })
    .from(deployments)
    .where(eq(deployments.status, "running"));

  // Always reconcile the concurrency counter — the counter can drift whenever
  // a process crashes mid-deploy, not just when a stuck deployment is found.
  // Running this unconditionally ensures the counter self-heals even when all
  // deploys finish cleanly but a release failed silently.
  try {
    const queued = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.status, "queued"));

    await reconcileActiveCounter(running.length);

    // Reconcile the Redis queue against DB state — removes orphaned entries left
    // by a partial Redis failure (rpush succeeded but subsequent eval threw).
    const activeIds = new Set([...running, ...queued].map((d) => d.id));
    await reconcileQueue(activeIds);
  } catch (err) {
    log.warn("Failed to reconcile deploy concurrency state:", err);
  }

  if (running.length === 0) return;

  // Mark every running deployment on first sight so the budget starts here, and
  // keep only the ones that have since exhausted it.
  const budgetMs = TIMEOUT_MINUTES * 60_000;
  const markedAt = Date.now();
  const stuck: typeof running = [];
  for (const deploy of running) {
    const elapsed = await observedRunningMs(deploy.id, markedAt);
    if (elapsed !== null && elapsed >= budgetMs) stuck.push(deploy);
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
      const liveness = await readActiveDeploy(deploy.appId);

      // Redis could not answer. Unknown is not dead — leave the row for the
      // next pass rather than failing a deploy that may still be building.
      if (!liveness.known) {
        log.warn(
          `Deployment ${deploy.id} is past its budget but the active-deploy key is unreadable — skipping`,
        );
        continue;
      }

      // Still the deploy holding the app. Ask it to stop through its own
      // cancellation path; its containers stay up until it lets go of the key.
      if (liveness.active?.deploymentId === deploy.id) {
        await requestDeployAbort(deploy.id);
        if (await acquireLock(`sweep:abort:${deploy.id}`, ABORT_LOG_TTL_MS)) {
          log.warn(
            `Deployment ${deploy.id} is past its budget but still registered as active — signalled it to cancel`,
          );
        }
        continue;
      }

      // A different deploy holds the app. This row is abandoned, but the
      // containers now belong to that deploy — record the failure and stop.
      const supersededByLiveDeploy = liveness.active !== null;

      const now = new Date();
      const timeoutLine = `[${now.toISOString()}] [TIMEOUT] Deployment timed out after ${TIMEOUT_MINUTES} minutes`;
      const updatedLog = deploy.log
        ? `${deploy.log}\n${timeoutLine}`
        : timeoutLine;

      // The budget itself. Wall time since enqueue would include the queue wait.
      const durationMs = TIMEOUT_MINUTES * 60_000;

      const failed = await db
        .update(deployments)
        .set({
          status: "failed",
          log: updatedLog,
          finishedAt: now,
          durationMs,
        })
        .where(
          and(eq(deployments.id, deploy.id), eq(deployments.status, "running")),
        )
        .returning({ id: deployments.id });

      // The deploy finished on its own between the liveness read and here.
      if (failed.length === 0) continue;

      const app = appMap.get(deploy.appId);

      if (app && !supersededByLiveDeploy) {
        // Reset the app status if it's still "deploying"
        await db
          .update(apps)
          .set({ status: "stopped", updatedAt: now })
          .where(
            and(eq(apps.id, deploy.appId), eq(apps.status, "deploying")),
          );

        // Re-read liveness immediately before touching Docker — a new deploy
        // can have claimed the app while the rows above were being written.
        const recheck = await readActiveDeploy(deploy.appId);
        if (recheck.known && recheck.active === null) {
          try {
            const envName = await envNameFor(deploy.environmentId, deploy.appId);
            await stopDeadDeployEnvironment(deploy.appId, app.name, envName);
          } catch (err) {
            log.warn(`Could not clear the environment for deployment ${deploy.id}:`, err);
          }
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
  trigger: string;
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
      trigger: deployments.trigger,
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
          trigger: candidate.trigger,
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
  const envName = await envNameFor(candidate.environmentId, candidate.appId);
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
    environmentId: candidate.environmentId,
  });
}

/**
 * Mirrors the deploy's own resolution: the named environment, else the app's
 * default one, else production. The row's environmentId is null whenever the
 * caller omitted it, and the deploy resolves that against `isDefault`.
 */
async function envNameFor(environmentId: string | null, appId: string): Promise<string> {
  if (environmentId) {
    const env = await db.query.environments.findFirst({
      where: eq(environments.id, environmentId),
      columns: { name: true },
    });
    if (env) return env.name;
  }

  const defaultEnv = await db.query.environments.findFirst({
    where: and(eq(environments.appId, appId), eq(environments.isDefault, true)),
    columns: { name: true },
  });
  return defaultEnv?.name ?? "production";
}
