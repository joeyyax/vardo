// Runs claimed deploys in this process: lease renewal, cancels, the claim fence and the drain.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, deployments, type DeployCancelReason } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { instanceId } from "@/lib/worker/instance";
import { VARDO_SELF_APP_NAME } from "@/lib/self-app-name";
import type { DeployAbortReason, DeployResult, DeployStage } from "@/lib/docker/deploy";
import {
  LEASE_RENEW_MS,
  claimedSlot,
  dropSupersede,
  enterSwap,
  markStage,
  newestQueuedIn,
  releaseExclusive,
  renewLeases,
  type ClaimedDeploy,
} from "./queue";
import { clearRunningForOldSweeper, markRunningForOldSweeper } from "./legacy-compat";

const log = logger.child("deploy-executor");

/** Stages where a cancel costs nothing: the previous slot still serves. */
export const SAFE_CANCEL_STAGES: ReadonlySet<string> = new Set<DeployStage>(["clone", "compose", "build"]);

type Job = {
  row: ClaimedDeploy;
  controller: AbortController;
  /** The stage in flight; null before the first one. */
  stage: DeployStage | null;
  done: Promise<void>;
};

type State = { jobs: Map<string, Job>; draining: boolean; renewTimer: NodeJS.Timeout | null; renewing: boolean };

// Shared across Next bundles, like the loops that use it.
const g = globalThis as unknown as { __vardo_deploy_executor?: State };
const state: State = (g.__vardo_deploy_executor ??= { jobs: new Map(), draining: false, renewTimer: null, renewing: false });

/** This process, as `claimed_by` names it. */
export function executorId(): string {
  return instanceId();
}

/** Ids of the deploys this process runs. */
export function runningHere(): string[] {
  return [...state.jobs.keys()];
}

/** Whether this process has stopped taking new deploys. */
export function isDraining(): boolean {
  return state.draining;
}

function safe(job: Job): boolean {
  return job.stage === null || SAFE_CANCEL_STAGES.has(job.stage);
}

function abort(job: Job, reason: DeployAbortReason): void {
  if (job.controller.signal.aborted) return;
  log.info(`Stopping deployment ${job.row.id}: ${"lost" in reason ? "claim lost" : "superseded" in reason ? "superseded" : reason.reason}`);
  job.controller.abort(reason);
}

/** Applies a cancel request. A user or timeout cancel waits for a safe stage or the next boundary; a supersede and a lost claim stop only in a safe stage. */
async function applyCancel(job: Job, reason: DeployCancelReason, atBoundary: boolean): Promise<void> {
  if (job.controller.signal.aborted) return;
  if (reason === "supersede") {
    if (!safe(job)) return;
    const by = await newestQueuedIn(job.row.scopeKey);
    if (!by) {
      await dropSupersede(job.row.id);
      return;
    }
    abort(job, { superseded: true, supersededBy: by });
    return;
  }
  if (atBoundary || safe(job)) abort(job, { killed: true, reason });
}

/** The watchdog holds off restarts while any `deploy:active:*` key exists (scripts/watchdog.sh). */
const WATCHDOG_KEY = (id: string) => `deploy:active:${id}`;
const WATCHDOG_TTL_MS = 30_000;

async function markActive(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const { redis } = await import("@/lib/redis");
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.set(WATCHDOG_KEY(id), "1", "PX", WATCHDOG_TTL_MS);
    await pipeline.exec();
  } catch {
    // Expires on its own; the watchdog reads a missing Redis as unknown.
  }
}

async function clearActive(id: string): Promise<void> {
  try {
    const { redis } = await import("@/lib/redis");
    await redis.del(WATCHDOG_KEY(id));
  } catch {
    // Expires on its own.
  }
}

async function renewPass(): Promise<void> {
  if (state.renewing || state.jobs.size === 0) return;
  state.renewing = true;
  try {
    void markActive(runningHere());
    void markRunningForOldSweeper([...state.jobs.values()].map((j) => ({ id: j.row.id, scopeKey: j.row.scopeKey, stage: j.stage })));
    const { cancel, lost } = await renewLeases(executorId(), runningHere());
    for (const { id, reason } of cancel) {
      const job = state.jobs.get(id);
      if (job) await applyCancel(job, reason ?? "user", false);
    }
    for (const id of lost) {
      const job = state.jobs.get(id);
      if (job && safe(job)) abort(job, { lost: true });
    }
  } catch (err) {
    log.warn("Couldn't renew deploy leases:", err);
  } finally {
    state.renewing = false;
  }
}

function ensureRenewing(): void {
  if (state.renewTimer) return;
  state.renewTimer = setInterval(() => void renewPass(), LEASE_RENEW_MS);
  state.renewTimer.unref?.();
}

function stopRenewingWhenIdle(): void {
  if (state.jobs.size > 0 || !state.renewTimer) return;
  clearInterval(state.renewTimer);
  state.renewTimer = null;
}

/** Records the stage and acts on a cancel request at the boundary. */
async function onStage(job: Job, stage: DeployStage): Promise<void> {
  job.stage = stage;
  try {
    const marked = await markStage(executorId(), job.row.id, stage);
    if (marked === null) {
      if (safe(job)) abort(job, { lost: true });
      return;
    }
    if (marked.cancel) await applyCancel(job, marked.cancel, true);
  } catch (err) {
    log.warn(`Couldn't record stage ${stage} for ${job.row.id}:`, err);
  }
}

/** Fails a claimed row that can't run, such as one whose app is gone. Appends to the log so far. */
async function failClaimed(id: string, message: string): Promise<void> {
  const now = new Date();
  const line = `[${now.toISOString()}] [deploy] ERROR: ${message}`;
  await db
    .update(deployments)
    .set({ status: "failed", log: sql`coalesce(${deployments.log} || E'\n', '') || ${line}`, finishedAt: now })
    .where(and(eq(deployments.id, id), eq(deployments.claimedBy, executorId()), eq(deployments.status, "running")));
}

export type RunDeployment = typeof import("@/lib/docker/deploy").runDeployment;

/** Rebuilds the deploy's options from its row and runs it. */
export async function runClaimedDeployment(row: ClaimedDeploy, job: Job, run?: RunDeployment): Promise<DeployResult | null> {
  const app = await db.query.apps.findFirst({ where: eq(apps.id, row.appId), columns: { organizationId: true } });
  if (!app) {
    await failClaimed(row.id, "The app no longer exists");
    return null;
  }
  const { trackDeploy } = await import("@/lib/git-integration/github-feedback");
  const runDeployment = run ?? (await import("@/lib/docker/deploy")).runDeployment;
  const request = row.request ?? {};
  const feedback = trackDeploy(row.id, { trigger: row.trigger, gitSha: request.gitSha });
  const executor = executorId();
  try {
    const result = await runDeployment(row.id, {
      appId: row.appId,
      organizationId: app.organizationId,
      trigger: row.trigger,
      triggeredBy: row.triggeredBy ?? undefined,
      environmentId: row.environmentId ?? undefined,
      groupEnvironmentId: row.groupEnvironmentId ?? undefined,
      rollback: request.rollback,
      gitSha: request.gitSha,
      pinIntent: request.pinIntent,
      rebuild: request.rebuild,
      deploymentId: row.id,
      executorId: executor,
      signal: job.controller.signal,
      fence: () => enterSwap(executor, row.id),
      deploySlot: row.onTarget ? claimedSlot(executor, row) : undefined,
      onStage: (stage, status) => {
        feedback.stage(stage, status);
        if (status === "running") void onStage(job, stage);
      },
    });
    feedback.finish(result);
    return result;
  } catch (err) {
    feedback.finish({ status: "cancelled", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Whether a finished deploy keeps its exclusive flag: a self-deploy that committed hands it to the new slot. */
async function keepsExclusive(id: string, result: DeployResult | null): Promise<boolean> {
  if (!result?.success) return false;
  const [row] = await db
    .select({ name: apps.name, slot: deployments.slot })
    .from(deployments)
    .innerJoin(apps, eq(apps.id, deployments.appId))
    .where(eq(deployments.id, id));
  return row?.name === VARDO_SELF_APP_NAME && !!row.slot;
}

export type StartOpts = {
  /** Stands in for the engine in tests. */
  run?: RunDeployment;
};

/** Starts a claimed deploy without waiting for it. */
export function startClaimed(row: ClaimedDeploy, opts: StartOpts = {}): Promise<void> {
  const job: Job = { row, controller: new AbortController(), stage: null, done: Promise.resolve() };
  state.jobs.set(row.id, job);
  ensureRenewing();
  void markActive([row.id]);
  void markRunningForOldSweeper([{ id: row.id, scopeKey: row.scopeKey, stage: null }]);
  job.done = (async () => {
    let result: DeployResult | null = null;
    try {
      result = await runClaimedDeployment(row, job, opts.run);
    } catch (err) {
      log.error(`Deployment ${row.id} threw:`, err);
      await failClaimed(row.id, err instanceof Error ? err.message : String(err)).catch(() => {});
    } finally {
      try {
        if (!(await keepsExclusive(row.id, result))) await releaseExclusive(row.id);
      } catch (err) {
        log.warn(`Couldn't clear the exclusive flag of ${row.id}:`, err);
      }
      state.jobs.delete(row.id);
      stopRenewingWhenIdle();
      await clearActive(row.id);
      await clearRunningForOldSweeper(row);
    }
  })();
  return job.done;
}

/** Stops taking deploys and waits for those running, up to the budget. Leases keep renewing meanwhile. Returns the ids still running. */
export async function drainDeploys(budgetMs: number): Promise<string[]> {
  state.draining = true;
  const deadline = Date.now() + budgetMs;
  if (state.jobs.size > 0) log.info(`Draining ${state.jobs.size} deploy(s): ${runningHere().join(", ")}`);
  while (state.jobs.size > 0 && Date.now() < deadline) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...state.jobs.values()].map((j) => j.done)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.min(1_000, Math.max(0, deadline - Date.now())));
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }
  return runningHere();
}

/** Tests only. */
export async function resetExecutorForTests(): Promise<void> {
  await Promise.allSettled([...state.jobs.values()].map((j) => j.done));
  state.jobs.clear();
  state.draining = false;
  if (state.renewTimer) clearInterval(state.renewTimer);
  state.renewTimer = null;
}

/** Tests only: one renewal pass now. */
export function renewNowForTests(): Promise<void> {
  return renewPass();
}
