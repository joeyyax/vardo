// Applies local updates and advances the mesh rollout after verifying each finished update.

import { and, desc, eq, gt, inArray, isNull, isNotNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import pkg from "@/package.json";
import { db } from "@/lib/db";
import { apps, backupRuns, backups, deployments, instanceRestores } from "@/lib/db/schema";
import { VARDO_SELF_APP_NAME } from "@/lib/self-app-name";
import { logger } from "@/lib/logger";
import { isSelfDeployLayout } from "@/lib/paths";
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { getBuildSha, type ChannelUpdate } from "@/lib/version";
import { formatVersion } from "@/lib/lifecycle/self-deploy";
import { sameCommit } from "./commit";
import { DEPLOY_TIMEOUT_MS, isRunActive, verifyStep } from "./decide";
import type { GateInputs } from "./gates";
import { updateFailed } from "./lifecycle";
import { setLocalVardoStatus } from "./peer-status";
import { getUpdateRun, getUpdateState, setUpdateRun, updateState, type UpdateRun, type UpdateState } from "./store";

const log = logger.child("self-update");

const TICK_MS = 60_000;
const LOCK_KEY = "self-update:tick";
const LOCK_MS = 10 * 60_000;
const START_LOCK_KEY = "self-update:start";
/** A backup row older than this is stale, not running. */
const BACKUP_STALE_MS = 12 * 60 * 60_000;
const HEALTH_REFRESH_MS = 5 * 60_000;

export class UpdateBlockedError extends Error {}

async function vardoApp(): Promise<{ id: string; organizationId: string } | null> {
  const app = await db.query.apps.findFirst({
    where: and(eq(apps.name, VARDO_SELF_APP_NAME), isNull(apps.parentAppId), eq(apps.isSystemManaged, true)),
    columns: { id: true, organizationId: true },
  });
  return app ?? null;
}

async function lastSuccessfulDeployment(appId: string): Promise<string | null> {
  const row = await db.query.deployments.findFirst({
    where: and(eq(deployments.appId, appId), eq(deployments.status, "success"), isNotNull(deployments.gitSha)),
    orderBy: [desc(deployments.finishedAt)],
    columns: { id: true },
  });
  return row?.id ?? null;
}

// Health

let health: { unhealthy: string[]; at: number } | null = null;

async function unhealthyServices(fresh = false): Promise<string[]> {
  if (!fresh && health && Date.now() - health.at < HEALTH_REFRESH_MS) return health.unhealthy;
  const { getSystemHealth } = await import("@/lib/config/health");
  const result = await getSystemHealth();
  const unhealthy = result.services.filter((s) => s.status === "unhealthy").map((s) => s.name);
  health = { unhealthy, at: Date.now() };
  return unhealthy;
}

// Gates

let unhealthySince: number | null = null;

async function runningDrills(): Promise<number> {
  try {
    const { listContainers } = await import("@/lib/docker/client");
    return (await listContainers()).filter((c) => c.name.startsWith("vardo-drill-")).length;
  } catch {
    return 0;
  }
}

export async function collectGateInputs(targetSha: string, state: UpdateState): Promise<GateInputs> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - BACKUP_STALE_MS);
  const [active, runningBackupRows, openRuns, restores, drills, unhealthy] = await Promise.all([
    // Running only: queued deploys can wait for a worker this update may be fixing.
    db.select({ id: deployments.id }).from(deployments).where(eq(deployments.status, "running")),
    db
      .select({ id: backups.id })
      .from(backups)
      .where(and(inArray(backups.status, ["pending", "running"]), gt(backups.startedAt, staleBefore))),
    db
      .select({ kind: backupRuns.kind })
      .from(backupRuns)
      .where(and(isNull(backupRuns.finishedAt), gt(backupRuns.deadlineAt, now))),
    db.select({ id: instanceRestores.id }).from(instanceRestores).where(eq(instanceRestores.status, "running")),
    runningDrills(),
    unhealthyServices(true),
  ]);
  unhealthySince = unhealthy.length === 0 ? null : (unhealthySince ?? now.getTime());
  const { readDiskSpace } = await import("@/lib/docker/disk-guard");
  return {
    activeDeploys: active.length,
    runningBackups: runningBackupRows.length + openRuns.filter((r) => r.kind !== "restore").length,
    runningRestores: restores.length + openRuns.filter((r) => r.kind === "restore").length,
    runningDrills: drills,
    disk: await readDiskSpace(),
    unhealthyServices: unhealthy,
    unhealthyForMs: unhealthySince === null ? 0 : now.getTime() - unhealthySince,
    targetFailedBefore: state.failedTargets.some((sha) => sameCommit(sha, targetSha)),
  };
}

// Starting an update

export type StartUpdateOptions = {
  trigger: "auto" | "manual";
  triggeredBy?: string;
  rolloutId?: string;
  channel: "main" | "releases";
  update: ChannelUpdate | null;
};

/** Dumps the database, then redeploys the `vardo` app. Auto refuses without a dump; Update now carries on. */
export async function startUpdate(opts: StartUpdateOptions): Promise<UpdateRun> {
  const lock = await acquireLock(START_LOCK_KEY, LOCK_MS);
  if (!lock) throw new UpdateBlockedError("An update is already starting");
  try {
    return await startUpdateUnlocked(opts);
  } finally {
    await releaseLock(START_LOCK_KEY, lock).catch(() => {});
  }
}

async function startUpdateUnlocked(opts: StartUpdateOptions): Promise<UpdateRun> {
  if (!isSelfDeployLayout()) throw new UpdateBlockedError("This install updates from the host: run sudo vardo update");
  if (isRunActive(await getUpdateRun())) throw new UpdateBlockedError("An update is already running");
  if (opts.channel === "releases" && !opts.update) throw new UpdateBlockedError("Couldn't reach GitHub for the latest release");
  if (opts.channel === "releases" && !opts.update?.hasUpdate) throw new UpdateBlockedError("Already on the latest release");
  const app = await vardoApp();
  const previousDeploymentId = app ? await lastSuccessfulDeployment(app.id) : null;

  let dumpFile: string | null = null;
  try {
    const { dumpVardoDatabase } = await import("./dump");
    dumpFile = await dumpVardoDatabase();
    log.info(`Database dumped to ${dumpFile}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.trigger === "auto") throw new UpdateBlockedError(`Database dump failed: ${message}`);
    log.warn(`Database dump failed, updating anyway: ${message}`);
  }

  // A coordinated rollout must deploy the commit it checked, even when following main.
  const pin = opts.update && (opts.channel === "releases" || opts.rolloutId) ? opts.update.targetSha : undefined;
  const { triggerSelfDeploy } = await import("@/lib/lifecycle/deploy-request");
  const { deploymentId } = await triggerSelfDeploy({ triggeredBy: opts.triggeredBy, gitSha: pin });

  const run: UpdateRun = {
    id: nanoid(),
    trigger: opts.trigger,
    triggeredBy: opts.triggeredBy,
    state: "deploying",
    startedAt: new Date().toISOString(),
    deploymentId,
    previousDeploymentId,
    fromSha: getBuildSha(),
    toSha: pin ?? opts.update?.targetSha ?? null,
    toLabel: opts.update?.targetLabel ?? "main",
    channel: opts.channel,
    dumpFile,
    rolloutId: opts.rolloutId,
  };
  await setUpdateRun(run);
  log.info(`Updating Vardo (${opts.trigger}) to ${run.toLabel} as ${deploymentId}`);
  return run;
}

// Following an update

async function deploymentRow(id: string) {
  return db.query.deployments.findFirst({
    where: eq(deployments.id, id),
    columns: { status: true, gitSha: true },
  });
}

async function finish(run: UpdateRun, state: UpdateRun["state"], extra: Partial<UpdateRun> = {}): Promise<void> {
  await setUpdateRun({ ...run, ...extra, state, finishedAt: new Date().toISOString() });
}

async function markTargetFailed(sha: string | null): Promise<void> {
  if (!sha) return;
  await updateState((s) => ({ ...s, failedTargets: [...s.failedTargets.filter((t) => !sameCommit(t, sha)), sha].slice(-20) }));
}

async function rollBack(run: UpdateRun, reason: string): Promise<void> {
  const app = await vardoApp();
  await markTargetFailed(run.toSha ?? run.fromSha);
  if (!app || !run.previousDeploymentId) {
    await finish(run, "rollback-failed", { error: `${reason}. No earlier deploy to roll back to.` });
    await reportFailed(run, reason, false);
    return;
  }
  const { enqueueDeploy } = await import("@/lib/deploy/queue");
  const { id: rollbackDeploymentId } = await enqueueDeploy({
    appId: app.id,
    trigger: "rollback",
    rollback: { targetDeploymentId: run.previousDeploymentId },
  });
  await setUpdateRun({ ...run, state: "rolling-back", rollbackDeploymentId, error: reason });
  log.warn(`${reason}; rolling back as ${rollbackDeploymentId}`);
  await reportFailed(run, reason, true);
}

/** Reports the run's failure to the update lifecycle, in the deploy's thread. */
async function reportFailed(run: UpdateRun, reason: string, rolledBack: boolean, step = "post-update health check"): Promise<void> {
  await updateFailed({
    id: run.deploymentId,
    source: "self-deploy",
    startedAt: Date.parse(run.startedAt),
    fromVersion: formatVersion(pkg.version, run.fromSha) ?? pkg.version,
    step,
    error: reason,
    rolledBack,
  }).catch((err) => log.error("Couldn't report the failed update:", err));
}

export async function advanceRun(run: UpdateRun, now = Date.now()): Promise<void> {
  if (run.state === "deploying") {
    const row = await deploymentRow(run.deploymentId);
    const status = row?.status;
    if (status === "success") {
      // The console the deploy replaced stops soon; only the new one verifies.
      const build = getBuildSha();
      if (build && row?.gitSha && !sameCommit(build, row.gitSha)) return;
      await setUpdateRun({ ...run, state: "verifying", verifyStartedAt: new Date(now).toISOString(), passes: 0, fails: 0 });
      return;
    }
    if (status === "failed" || status === "cancelled" || status === "superseded" || status === "rolled_back") {
      // The deploy kept the old console serving and its failure email already went out.
      if (run.trigger === "auto") await markTargetFailed(run.toSha);
      await finish(run, "failed", { error: `Deploy ${status}` });
      return;
    }
    if (now - Date.parse(run.startedAt) > DEPLOY_TIMEOUT_MS) await finish(run, "failed", { error: "Deploy didn't finish" });
    return;
  }

  if (run.state === "verifying") {
    const unhealthy = await unhealthyServices(true).catch(() => ["health probe"]);
    const step = verifyStep({
      startedAt: Date.parse(run.verifyStartedAt ?? run.startedAt),
      now,
      passes: run.passes ?? 0,
      fails: run.fails ?? 0,
      unhealthy,
    });
    if (step.next === "verified") await finish(run, "verified");
    else if (step.next === "rollback") await rollBack(run, step.reason);
    else await setUpdateRun({ ...run, passes: step.passes, fails: step.fails });
    return;
  }

  if (run.state === "rolling-back" && run.rollbackDeploymentId) {
    const status = (await deploymentRow(run.rollbackDeploymentId))?.status;
    if (status === "success") await finish(run, "rolled-back");
    else if (status && status !== "queued" && status !== "running") {
      await finish(run, "rollback-failed");
      await reportFailed(run, `Rollback ${status}; the update is still running`, false, "rollback");
    }
  }
}

/** Records when this build started running and publishes it, with health, to mesh peers. */
async function trackVersion(state: UpdateState, now: Date): Promise<UpdateState> {
  const sha = getBuildSha();
  let next = state;
  if (sha && !sameCommit(state.versionSince?.sha, sha)) {
    next = await updateState((s) => ({ ...s, versionSince: { sha, since: now.toISOString() } }));
  }
  const unhealthy = await unhealthyServices().catch(() => null);
  setLocalVardoStatus({ since: next.versionSince?.since ?? null, healthy: unhealthy ? unhealthy.length === 0 : null });
  return next;
}

export async function tickSelfUpdate(now = new Date()): Promise<void> {
  const lock = await acquireLock(LOCK_KEY, LOCK_MS);
  if (!lock) return;
  try {
    await trackVersion(await getUpdateState(), now);
    const run = await getUpdateRun();
    if (run && isRunActive(run, now.getTime())) {
      await advanceRun(run, now.getTime());
      return;
    }
    const { tickRollout } = await import("./coordinator");
    await tickRollout(now);
  } finally {
    await releaseLock(LOCK_KEY, lock).catch(() => {});
  }
}

export const selfUpdateLoop = new IntervalLoop({
  name: "self-update",
  intervalMs: TICK_MS,
  firstRunMs: 30_000,
  log,
  run: () => tickSelfUpdate(),
});
