import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
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
import { deployScope, deployWorker, publishKillSignal } from "@/lib/docker/deploy-cancel";
import { appEnvDir } from "@/lib/paths";
import { detectActiveSlot, type Slot as SlotName } from "@/lib/docker/slots";
import {
  decideStandbySweep,
  readCurrentSlot,
  runningProjects,
  stopStandbySlot,
  SLOTS,
} from "@/lib/docker/standby-slot";
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

/** Held by deploy-cancel while a deploy owns the app environment. */
const activeDeployKey = (scope: string) => `deploy:active:${scope}`;

/** When this sweep first saw a deployment in "running". */
const runningSinceKey = (deploymentId: string) => `deploy:sweep:running-since:${deploymentId}`;

/** Outlives the budget; an expired mark only restarts the clock. */
const RUNNING_MARK_TTL_MS = TIMEOUT_MINUTES * 60_000 * 4;

/** Rate-limits the "still alive" log line to once per timeout budget. */
const ABORT_LOG_TTL_MS = TIMEOUT_MINUTES * 60_000;

type ActiveDeployEntry = { deploymentId: string; stage?: string };

/**
 * Who owns `deploy:active:{appId}` right now.
 * `known: false` means unknown, never "nothing is running", or a Redis blip becomes a fleet-wide outage.
 */
type Liveness = { known: true; active: ActiveDeployEntry | null } | { known: false };

async function readActiveDeploy(scope: string): Promise<Liveness> {
  let raw: string | null;
  try {
    raw = await redis.get(activeDeployKey(scope));
  } catch (err) {
    log.warn(`Could not read the active-deploy key for ${scope}:`, err);
    return { known: false };
  }

  if (raw === null) return { known: true, active: null };

  try {
    const parsed = JSON.parse(raw) as ActiveDeployEntry;
    if (typeof parsed?.deploymentId !== "string") return { known: false };
    return { known: true, active: parsed };
  } catch {
    log.warn(`Unparseable active-deploy entry for ${scope} — treating as unknown`);
    return { known: false };
  }
}

/**
 * How long this sweep has seen a deployment "running", or null when Redis can't answer.
 * `startedAt` is the enqueue time, so it can't serve as the running clock.
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
 * Stop the dead deploy's environment once Docker confirms it serves nothing.
 * Its slot is often the only one left, so any probe failure leaves it alone.
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

/** Fail deployments running past the timeout budget, measured from when this sweep first saw them. */
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

  // Always reconcile; the counter drifts whenever a process crashes mid-deploy.
  try {
    const queued = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.status, "queued"));

    await reconcileActiveCounter(running.length);

    // Drop queue entries orphaned by a partial Redis failure.
    const activeIds = new Set([...running, ...queued].map((d) => d.id));
    await reconcileQueue(activeIds);
  } catch (err) {
    log.warn("Failed to reconcile deploy concurrency state:", err);
  }

  if (running.length === 0) return;

  // Mark each running deployment on first sight; keep those past the budget.
  const budgetMs = TIMEOUT_MINUTES * 60_000;
  const markedAt = Date.now();
  const stuck: typeof running = [];
  for (const deploy of running) {
    const elapsed = await observedRunningMs(deploy.id, markedAt);
    if (elapsed !== null && elapsed >= budgetMs) stuck.push(deploy);
  }

  if (stuck.length === 0) return;

  log.info(`Found ${stuck.length} stuck deployment(s)`);

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
    const lockKey = `sweep:deploy:${deploy.id}`;
    const acquired = await acquireLock(lockKey, 60_000);
    if (!acquired) continue;

    try {
      const scope = await deployScope(deploy.appId, deploy.environmentId);
      const liveness = await readActiveDeploy(scope);

      // Unknown isn't dead; leave the row for the next pass.
      if (!liveness.known) {
        log.warn(
          `Deployment ${deploy.id} is past its budget but the active-deploy key is unreadable — skipping`,
        );
        continue;
      }

      // Still holding the app: ask it to cancel through its own path.
      if (liveness.active?.deploymentId === deploy.id) {
        await requestDeployAbort(deploy.id);
        if (await acquireLock(`sweep:abort:${deploy.id}`, ABORT_LOG_TTL_MS)) {
          log.warn(
            `Deployment ${deploy.id} is past its budget but still registered as active — signalled it to cancel`,
          );
        }
        continue;
      }

      // Another deploy holds the app and owns the containers; only record the failure.
      const supersededByLiveDeploy = liveness.active !== null;

      const now = new Date();
      const timeoutLine = `[${now.toISOString()}] [TIMEOUT] Deployment timed out after ${TIMEOUT_MINUTES} minutes`;
      const updatedLog = deploy.log
        ? `${deploy.log}\n${timeoutLine}`
        : timeoutLine;

      // The budget itself.
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
        // Only the default environment owns the app status.
        if (scope === deploy.appId) {
          await db
            .update(apps)
            .set(statusChange("stopped", now))
            .where(
              and(eq(apps.id, deploy.appId), eq(apps.status, "deploying")),
            );
        }

        // Re-read liveness before touching Docker; a new deploy may have claimed the app.
        const recheck = await readActiveDeploy(scope);
        if (recheck.known && recheck.active === null) {
          try {
            const envName = await envNameFor(deploy.environmentId, deploy.appId);
            await stopDeadDeployEnvironment(deploy.appId, app.name, envName);
          } catch (err) {
            log.warn(`Could not clear the environment for deployment ${deploy.id}:`, err);
          }
        }
      }

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
            appName: app.name,
            durationMs,
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

/** A queued deploy with no live worker for this long was orphaned by a stopped process. */
const ORPHAN_QUEUED_MS = 2 * 60_000;

/** Cancel queued deployments whose process died, or that sat in the queue past twice the timeout. */
export async function sweepStuckQueuedDeployments(): Promise<void> {
  const queueTimeoutMinutes = TIMEOUT_MINUTES * 2;
  const now = Date.now();
  const timeoutCutoff = now - queueTimeoutMinutes * 60_000;

  const candidates = await db
    .select({
      id: deployments.id,
      appId: deployments.appId,
      startedAt: deployments.startedAt,
      log: deployments.log,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.status, "queued"),
        lt(deployments.startedAt, new Date(now - ORPHAN_QUEUED_MS)),
      ),
    );

  const stuck: (typeof candidates[number] & { reason: string })[] = [];
  for (const deploy of candidates) {
    if (new Date(deploy.startedAt).getTime() < timeoutCutoff) {
      stuck.push({ ...deploy, reason: `was stuck in the queue for ${queueTimeoutMinutes} minutes` });
    } else if ((await deployWorker(deploy.id)) === "gone") {
      stuck.push({ ...deploy, reason: "never started — the process that queued it stopped" });
    }
  }

  if (stuck.length === 0) return;

  log.info(`Found ${stuck.length} stuck queued deployment(s)`);

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
      const message = `Deployment ${deploy.reason} and was cancelled`;
      const line = `[${now.toISOString()}] [CANCELLED] ${message}`;

      await db
        .update(deployments)
        .set({
          status: "cancelled",
          log: deploy.log ? `${deploy.log}\n${line}` : line,
          finishedAt: now,
          durationMs,
        })
        .where(
          and(eq(deployments.id, deploy.id), eq(deployments.status, "queued")),
        );

      await removeFromQueue(deploy.id).catch(() => {});

      const app = appMap.get(deploy.appId);
      if (app) {
        addEvent(app.organizationId, {
          type: "deploy.status",
          title: "Queued deploy cancelled",
          message,
          appId: deploy.appId,
          deploymentId: deploy.id,
          status: "cancelled",
          success: false,
          durationMs,
        }).catch(() => {});
      }

      try {
        const { emit } = await import("@/lib/notifications/dispatch");
        if (app) {
          const projectName = app.displayName || app.name;
          emit(app.organizationId, {
            type: "deploy.failed",
            title: `Deploy cancelled: ${projectName}`,
            message: `${message}.`,
            projectName,
            appId: deploy.appId,
            deploymentId: deploy.id,
            errorMessage: message,
            appName: app.name,
            failedStage: "queued",
          });
        }
      } catch {
        // notification failure is non-fatal
      }

      log.info(`Cancelled queued deployment ${deploy.id} (app ${deploy.appId}) — ${deploy.reason}`);
    } catch (err) {
      log.error(`Failed to sweep queued deployment ${deploy.id}:`, err);
    }
  }
}

// Auto-rollback grace period

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

/** Roll back apps whose containers stopped inside their post-deploy grace period. */
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

  // Act only while the watched deploy is still the one serving.
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

  // One attempt per deployment across every instance.
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

// Standby slot reclamation

/** Quiet time after a deploy before a running standby counts as stranded. Must exceed the deploy budget and rollback grace. */
const STANDBY_GRACE_MS = 30 * 60_000;

/** Rate-limits the refusal log to once an hour per environment. */
const AMBIGUOUS_LOG_TTL_MS = 60 * 60_000;

/**
 * Stop standby slots running long after their deploy; Traefik would split traffic across both.
 * The live slot comes from the `current` symlink only; anything ambiguous is refused.
 */
export async function sweepStandbySlots(): Promise<void> {
  const projects = await runningProjects();
  if (projects === null) return;

  // Prefixes running both slots at once.
  const doubled = new Set<string>();
  for (const project of projects) {
    for (const slot of SLOTS) {
      const suffix = `-${slot}`;
      if (!project.endsWith(suffix)) continue;
      const prefix = project.slice(0, -suffix.length);
      if (SLOTS.every((s) => projects.has(`${prefix}-${s}`))) doubled.add(prefix);
    }
  }
  if (doubled.size === 0) return;

  const rows = await db
    .select({
      appId: apps.id,
      appName: apps.name,
      appStatus: apps.status,
      organizationId: apps.organizationId,
      envId: environments.id,
      envName: environments.name,
    })
    .from(environments)
    .innerJoin(apps, eq(environments.appId, apps.id));

  // Names may contain dashes, so two app/env pairs can share a prefix; those are skipped.
  const byPrefix = new Map<string, typeof rows>();
  for (const row of rows) {
    const prefix = `${row.appName}-${row.envName}`;
    if (!doubled.has(prefix)) continue;
    const bucket = byPrefix.get(prefix);
    if (bucket) bucket.push(row);
    else byPrefix.set(prefix, [row]);
  }

  for (const [prefix, matches] of byPrefix) {
    const row = matches[0];
    try {
      if (matches.length > 1) {
        await refuse(row.appId, row.envName, `${prefix} matches ${matches.length} app/environment pairs`);
        continue;
      }

      // A deploy runs both slots on purpose.
      if (row.appStatus === "deploying") continue;
      const liveness = await readActiveDeploy(await deployScope(row.appId, row.envId));
      if (!liveness.known || liveness.active !== null) continue;

      const latest = await db.query.deployments.findFirst({
        where: eq(deployments.appId, row.appId),
        orderBy: [desc(deployments.startedAt)],
        columns: { status: true, finishedAt: true },
      });
      if (!latest || latest.status === "running" || latest.status === "queued") continue;
      if (!latest.finishedAt) continue;
      if (Date.now() - new Date(latest.finishedAt).getTime() < STANDBY_GRACE_MS) continue;

      if (!(await acquireLock(`sweep:standby:${row.appId}:${row.envName}`, 60_000))) continue;

      const appDir = appEnvDir(row.appName, row.envName);
      const currentSlot = await readCurrentSlot(appDir);

      // Re-read; a deploy may have started during the DB round-trips.
      const live = await runningProjects();
      const running = live
        ? (Object.fromEntries(
            SLOTS.map((s) => [s, live.has(`${prefix}-${s}`)]),
          ) as Record<SlotName, boolean>)
        : null;

      const verdict = decideStandbySweep({ currentSlot, running });
      if (!verdict.act) {
        if (verdict.refused) await refuse(row.appId, row.envName, verdict.reason);
        continue;
      }

      await stopStandbySlot(appDir, prefix, verdict.standby);
      log.info(
        `Stopped the ${verdict.standby} standby for ${row.appName} (${row.envName}) — it was running alongside ${currentSlot}`,
      );

      addEvent(row.organizationId, {
        type: "app.state-changed",
        title: "Standby slot reclaimed",
        message: `The ${verdict.standby} slot was still running alongside ${currentSlot} and taking a share of the traffic. It has been stopped.`,
        appId: row.appId,
      }).catch(() => {});
    } catch (err) {
      log.error(`Standby sweep failed for ${prefix}:`, err);
    }
  }
}

/** Log a refusal to act, at most once an hour per environment. */
async function refuse(appId: string, envName: string, reason: string): Promise<void> {
  if (!(await acquireLock(`standby:ambiguous:${appId}:${envName}`, AMBIGUOUS_LOG_TTL_MS))) return;
  log.warn(`Both slots are running for app ${appId} (${envName}) but it is not safe to act — ${reason}`);
}

/** Named environment, else the app's default, else production. Mirrors the deploy's resolution. */
async function envNameFor(environmentId: string | null, appId: string): Promise<string> {
  if (environmentId) {
    const env = await db.query.environments.findFirst({
      where: and(eq(environments.id, environmentId), eq(environments.appId, appId)),
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
