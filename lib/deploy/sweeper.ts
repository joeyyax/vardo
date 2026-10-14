import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { deployments } from "@/lib/db/schema/apps";
import { apps } from "@/lib/db/schema/apps";
import { environments } from "@/lib/db/schema/environments";
import { workerJobs } from "@/lib/db/schema";
import { addDeployLog, addEvent } from "@/lib/stream/producer";
import { acquireLock } from "@/lib/redis-lock";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { eq, and, lt, gt, desc, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { stopProject } from "@/lib/docker/deploy";
import { appEnvDir } from "@/lib/paths";
import { DEPLOY_TIMEOUT_MS } from "@/lib/docker/constants";
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
import { deployTimedOut, queuedDeployCancelled } from "@/lib/git-integration/github-feedback";
import { releaseHeldDeploy, requestCancel, scopeKeyFor } from "./queue";
import { addGroupEvent } from "./group-job";
import {
  evaluateWatch,
  MAX_GRACE_PERIOD_SECONDS,
  type Slot,
} from "./rollback-watch";

const log = logger.child("deploy-sweeper");

const TIMEOUT_MINUTES = DEPLOY_TIMEOUT_MS / 60_000;

/** One rollback attempt per deployment. A failed attempt is not retried. */
const ROLLBACK_ATTEMPT_TTL_MS = MAX_GRACE_PERIOD_SECONDS * 1000;

/** When this sweep first saw a deployment in "running". */
const runningSinceKey = (deploymentId: string) => `deploy:sweep:running-since:${deploymentId}`;

/** Outlives the budget; an expired mark only restarts the clock. */
const RUNNING_MARK_TTL_MS = TIMEOUT_MINUTES * 60_000 * 4;

/** Stages a crashed deploy can rerun from scratch: nothing it did touched a container. */
const REQUEUE_STAGES = ["clone", "compose", "build"];

/** Automatic deploys still queued after this are cancelled. Explicit ones never expire. */
export const AUTOMATIC_QUEUE_TTL_MS = 24 * 60 * 60_000;

/** A held deploy whose requester never released it. */
const HELD_TTL_MS = 15 * 60_000;

/** A row the pre-queue code wrote is left to its process for this long. */
const LEGACY_GRACE_MS = 2 * 60_000;

const line = (tag: string, message: string) => `[${new Date().toISOString()}] [${tag}] ${message}`;
const appendLog = (text: string) => sql`coalesce(${deployments.log} || E'\n', '') || ${text}`;

/** Writes a sweep line to the deploy's live stream too. */
function streamLine(deployId: string, text: string, stage: string | null): void {
  addDeployLog(deployId, { line: text, stage: stage ?? "queued", status: "running" }).catch((err) => log.warn(`Stream write for ${deployId} failed:`, err));
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

/** Whether the pre-queue code's process still renews this deployment's liveness key. "unknown" is not dead. */
async function legacyOwner(deploymentId: string): Promise<"live" | "gone" | "unknown"> {
  try {
    return (await redis.get(`deploy:worker:${deploymentId}`)) !== null ? "live" : "gone";
  } catch {
    return "unknown";
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

type DeadRow = { id: string; appId: string; environmentId: string | null; scopeKey: string | null; stage: string | null; startedAt: Date };

/** Fails a deploy whose executor stopped: records it, resets the app status and stops a slot that serves nothing. */
async function failDeadDeploy(deploy: DeadRow, reason: string, guard: ReturnType<typeof and>): Promise<boolean> {
  const now = new Date();
  const durationMs = now.getTime() - new Date(deploy.startedAt).getTime();
  const text = line("deploy", `ERROR: ${reason}`);
  const failed = await db
    .update(deployments)
    .set({ status: "failed", finishedAt: now, durationMs, exclusiveRequestedAt: null, log: appendLog(text) })
    .where(guard)
    .returning({ id: deployments.id });
  if (failed.length === 0) return false;
  streamLine(deploy.id, text, deploy.stage);

  Promise.resolve()
    .then(() => deployTimedOut(deploy.id, reason, durationMs))
    .catch((err) => log.warn(`Failure feedback for ${deploy.id} failed:`, err));

  const app = await db.query.apps.findFirst({
    where: eq(apps.id, deploy.appId),
    columns: { id: true, organizationId: true, name: true, displayName: true },
  });
  if (!app) return true;

  const scope = deploy.scopeKey ?? (await scopeKeyFor(deploy.appId, deploy.environmentId).catch(() => deploy.appId));
  // Only the default environment owns the app status; a deploy that took the scope since owns the containers.
  const [taken] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.scopeKey, scope), eq(deployments.status, "running")))
    .limit(1);
  if (!taken) {
    if (scope === deploy.appId) {
      await db.update(apps).set(statusChange("stopped", now)).where(and(eq(apps.id, deploy.appId), eq(apps.status, "deploying")));
    }
    try {
      await stopDeadDeployEnvironment(deploy.appId, app.name, await envNameFor(deploy.environmentId, deploy.appId));
    } catch (err) {
      log.warn(`Could not clear the environment for deployment ${deploy.id}:`, err);
    }
  }

  addEvent(app.organizationId, {
    type: "deploy.status",
    title: "Deploy failed",
    message: reason,
    appId: deploy.appId,
    deploymentId: deploy.id,
    status: "error",
    success: false,
    durationMs,
  }).catch(() => {});

  try {
    const { emit } = await import("@/lib/notifications/dispatch");
    const projectName = app.displayName || app.name;
    const { deployIncident } = await import("@/lib/incidents/deploy");
    const incident = await deployIncident(app.organizationId, { appId: deploy.appId, deploymentId: deploy.id, displayName: projectName }, false);
    emit(app.organizationId, {
      ...(incident ? { incident } : {}),
      type: "deploy.failed",
      title: `Deploy failed: ${projectName}`,
      message: reason,
      projectName,
      appId: deploy.appId,
      deploymentId: deploy.id,
      errorMessage: reason,
      appName: app.name,
      failedStage: deploy.stage ?? undefined,
      durationMs,
    });
  } catch {
    // notification failure is non-fatal
  }
  log.info(`Failed deployment ${deploy.id} (app ${deploy.appId}): ${reason}`);
  return true;
}

/**
 * The crash rule. A running deploy whose lease lapsed reruns once when it died in clone, compose or build;
 * otherwise it fails through the dead-owner path. Rows from before the queue fail once their process is gone.
 */
export async function sweepExpiredLeases(): Promise<void> {
  const expired = await db
    .select({
      id: deployments.id,
      appId: deployments.appId,
      environmentId: deployments.environmentId,
      scopeKey: deployments.scopeKey,
      stage: deployments.stage,
      attempts: deployments.attempts,
      claimedBy: deployments.claimedBy,
      cancelRequestedAt: deployments.cancelRequestedAt,
      startedAt: deployments.startedAt,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.status, "running"),
        or(lt(deployments.leaseExpiresAt, sql`now()`), and(isNull(deployments.claimedBy), isNull(deployments.leaseExpiresAt))),
      ),
    );

  for (const deploy of expired) {
    try {
      if (!deploy.claimedBy) {
        if (Date.now() - new Date(deploy.startedAt).getTime() < LEGACY_GRACE_MS) continue;
        if ((await legacyOwner(deploy.id)) !== "gone") continue;
        await failDeadDeploy(
          deploy,
          "The process running this deploy stopped",
          and(eq(deployments.id, deploy.id), eq(deployments.status, "running"), isNull(deployments.claimedBy)),
        );
        continue;
      }

      const stillExpired = and(eq(deployments.id, deploy.id), eq(deployments.status, "running"), lt(deployments.leaseExpiresAt, sql`now()`));
      const stage = deploy.stage ?? "queued";
      // Nothing ran before the first stage, so that requeue doesn't use up the rerun.
      const unstarted = !deploy.stage && !deploy.cancelRequestedAt;
      if (unstarted || (deploy.stage && REQUEUE_STAGES.includes(deploy.stage) && deploy.attempts === 0 && !deploy.cancelRequestedAt)) {
        const text = unstarted
          ? line("deploy", "Requeued: the executor that claimed it stopped before it started")
          : line("deploy", `Requeued: the executor running it stopped during ${stage}. It runs once more from the start`);
        const requeued = await db
          .update(deployments)
          .set({
            status: "queued",
            claimedBy: null,
            leaseExpiresAt: null,
            stage: null,
            attempts: unstarted ? sql`${deployments.attempts}` : sql`${deployments.attempts} + 1`,
            exclusiveRequestedAt: null,
            log: appendLog(text),
          })
          .where(stillExpired)
          .returning({ id: deployments.id });
        if (requeued.length > 0) {
          streamLine(deploy.id, text, deploy.stage);
          log.info(`Requeued deployment ${deploy.id}: its executor stopped during ${stage}`);
        }
        continue;
      }

      const reason = deploy.cancelRequestedAt
        ? `The executor stopped during ${stage} while cancelling`
        : deploy.attempts > 0 && REQUEUE_STAGES.includes(stage)
          ? `The executor stopped during ${stage} again, after one rerun`
          : `The executor running it stopped during ${stage}`;
      await failDeadDeploy(deploy, reason, stillExpired);
    } catch (err) {
      log.error(`Failed to sweep deployment ${deploy.id}:`, err);
    }
  }
}

/** Asks deploys running past the time budget to stop. Their executor cancels at the next safe point; a dead one hits the crash rule. */
export async function sweepStuckDeployments(): Promise<void> {
  const running = await db
    .select({ id: deployments.id, claimedBy: deployments.claimedBy, cancelReason: deployments.cancelReason })
    .from(deployments)
    .where(eq(deployments.status, "running"));
  if (running.length === 0) return;

  const budgetMs = TIMEOUT_MINUTES * 60_000;
  const markedAt = Date.now();
  for (const deploy of running) {
    const elapsed = await observedRunningMs(deploy.id, markedAt);
    if (elapsed === null || elapsed < budgetMs || !deploy.claimedBy) continue;
    if (deploy.cancelReason === "timeout" || deploy.cancelReason === "user") continue;
    const outcome = await requestCancel(deploy.id, "timeout").catch(() => "inactive" as const);
    if (outcome === "requested") log.warn(`Deployment ${deploy.id} passed ${TIMEOUT_MINUTES} minutes; asked it to stop`);
  }
}

/** Cancels automatic deploys queued past their TTL, held deploys nobody released, and handles queued rows from before the queue. */
export async function sweepQueuedDeployments(): Promise<void> {
  const now = Date.now();

  // Automatic deploys queued past the TTL. Explicit ones wait as long as it takes.
  const stale = await db
    .update(deployments)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
      log: appendLog(line("CANCELLED", `Still queued after ${AUTOMATIC_QUEUE_TTL_MS / 3_600_000} hours, so it was cancelled`)),
    })
    .where(
      and(
        eq(deployments.status, "queued"),
        inArray(deployments.trigger, ["webhook", "relay", "poll"]),
        lt(deployments.startedAt, new Date(now - AUTOMATIC_QUEUE_TTL_MS)),
      ),
    )
    .returning({ id: deployments.id, appId: deployments.appId });
  for (const row of stale) {
    log.info(`Cancelled deployment ${row.id}: queued for over ${AUTOMATIC_QUEUE_TTL_MS / 3_600_000} hours`);
    Promise.resolve()
      .then(() => queuedDeployCancelled(row.id, "Still queued after a day"))
      .catch((err) => log.warn(`Queue cancel feedback for ${row.id} failed:`, err));
  }

  // Held deploys whose requester never released them.
  const abandoned = await db
    .update(deployments)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
      log: appendLog(line("CANCELLED", "The import stopped before its deploy started")),
    })
    .where(
      and(
        eq(deployments.status, "queued"),
        isNull(deployments.scopeKey),
        sql`(${deployments.request}->>'held')::boolean IS TRUE`,
        lt(deployments.startedAt, new Date(now - HELD_TTL_MS)),
      ),
    )
    .returning({ id: deployments.id });
  for (const row of abandoned) log.info(`Cancelled held deployment ${row.id}: never released`);

  // Rows the pre-queue code queued and whose process is gone: pushes and polls rejoin the queue, the rest are cancelled.
  const legacy = await db
    .select({ id: deployments.id, trigger: deployments.trigger })
    .from(deployments)
    .where(
      and(
        eq(deployments.status, "queued"),
        isNull(deployments.scopeKey),
        isNull(deployments.request),
        lt(deployments.startedAt, new Date(now - LEGACY_GRACE_MS)),
      ),
    );
  for (const row of legacy) {
    if ((await legacyOwner(row.id)) !== "gone") continue;
    if (row.trigger === "webhook" || row.trigger === "relay" || row.trigger === "poll") {
      if (await releaseHeldDeploy(row.id)) log.info(`Queued deployment ${row.id} from before the update`);
      continue;
    }
    const cancelled = await db
      .update(deployments)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        log: appendLog(line("CANCELLED", "Queued before Vardo updated, without the options it needs to run. Deploy again")),
      })
      .where(and(eq(deployments.id, row.id), eq(deployments.status, "queued"), isNull(deployments.scopeKey)))
      .returning({ id: deployments.id });
    if (cancelled.length > 0) log.info(`Cancelled deployment ${row.id}: queued before the update`);
  }
}

/** Fails group jobs whose executor stopped. The app deploys they queued carry on. */
export async function sweepGroupJobs(): Promise<void> {
  const dead = await db
    .update(workerJobs)
    .set({ status: "failed", finishedAt: sql`now()` })
    .where(and(eq(workerJobs.status, "running"), isNotNull(workerJobs.leaseExpiresAt), lt(workerJobs.leaseExpiresAt, sql`now()`)))
    .returning({ id: workerJobs.id });
  for (const job of dead) {
    log.info(`Failed group deploy ${job.id}: its executor stopped`);
    await addGroupEvent(job.id, "done", { success: false, error: "The executor running this group deploy stopped", results: [] }).catch(() => {});
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
        `There's no previous version to roll back to. Manual intervention required.`,
        { deploymentId: candidate.deploymentId },
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
      const [holder] = await db
        .select({ id: deployments.id })
        .from(deployments)
        .where(and(eq(deployments.scopeKey, await scopeKeyFor(row.appId, row.envId)), eq(deployments.status, "running")))
        .limit(1);
      if (holder) continue;

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
