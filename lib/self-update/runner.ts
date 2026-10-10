// Applies Vardo updates: Update now, and Auto inside the maintenance window. Each tick also verifies a finished
// update from the new console and rolls it back through the engine when it turns unhealthy.

import { and, desc, eq, gt, inArray, isNull, isNotNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import pkg from "@/package.json";
import { db } from "@/lib/db";
import { apps, backupRuns, backups, deployments, instanceRestores, meshPeers } from "@/lib/db/schema";
import { VARDO_SELF_APP_NAME } from "@/lib/api/system-managed";
import type { BusEvent } from "@/lib/bus/events";
import { emit } from "@/lib/notifications/dispatch";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { logger } from "@/lib/logger";
import { isSelfDeployLayout } from "@/lib/paths";
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { closeOnShutdown } from "@/lib/shutdown";
import { getBuildSha, getChannelUpdate, type ChannelUpdate } from "@/lib/version";
import { formatVersion } from "@/lib/lifecycle/self-deploy";
import { canaryVerdict, sameCommit, type CanaryPeer, type CanaryVerdict } from "./canary";
import { DEPLOY_TIMEOUT_MS, decideTick, isRunActive, verifyStep } from "./decide";
import { evaluateGates, type GateFailure, type GateInputs } from "./gates";
import { setLocalVardoStatus } from "./peer-status";
import { effectiveChannel, type UpdatePolicy } from "./policy";
import { getUpdatePolicy, getUpdateRun, getUpdateState, setUpdateRun, updateState, type UpdateRun, type UpdateState } from "./store";
import { getInstanceTimezone } from "./timezone";
import { windowZone } from "./window";

const log = logger.child("self-update");

const TICK_MS = 60_000;
const LOCK_KEY = "self-update:tick";
const LOCK_MS = 10 * 60_000;
/** A backup row older than this is stale, not running. */
const BACKUP_STALE_MS = 12 * 60 * 60_000;
const HEALTH_REFRESH_MS = 5 * 60_000;
const SKIP_RENOTIFY_MS = 24 * 60 * 60_000;

export class UpdateBlockedError extends Error {}

async function emitToAdmins(event: BusEvent): Promise<void> {
  try {
    for (const orgId of await adminOrgIds()) emit(orgId, event);
  } catch (err) {
    log.error(`Couldn't send ${event.type}:`, err);
  }
}

function currentVersion(): string {
  return formatVersion(pkg.version, getBuildSha()) ?? pkg.version;
}

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
    db.select({ id: deployments.id }).from(deployments).where(inArray(deployments.status, ["queued", "running"])),
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
  const { readDiskSpace } = await import("@/lib/docker/disk-guard");
  return {
    activeDeploys: active.length,
    runningBackups: runningBackupRows.length + openRuns.filter((r) => r.kind !== "restore").length,
    runningRestores: restores.length + openRuns.filter((r) => r.kind === "restore").length,
    runningDrills: drills,
    disk: await readDiskSpace(),
    unhealthyServices: unhealthy,
    targetFailedBefore: state.failedTargets.some((sha) => sameCommit(sha, targetSha)),
  };
}

// Starting an update

export type StartUpdateOptions = {
  trigger: "auto" | "manual";
  triggeredBy?: string;
  channel: "main" | "releases";
  update: ChannelUpdate | null;
};

/** Dumps the database, then redeploys the `vardo` app. Auto refuses without a dump; Update now carries on. */
export async function startUpdate(opts: StartUpdateOptions): Promise<UpdateRun> {
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

  // Releases pin the tag's commit; main takes the branch tip.
  const pin = opts.channel === "releases" && opts.update ? opts.update.targetSha : undefined;
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
    await emitToAdmins(failedEvent(run, reason, false));
    return;
  }
  const { createDeployment } = await import("@/lib/docker/deploy");
  const { requestDeploy } = await import("@/lib/docker/deploy-cancel");
  const opts = {
    appId: app.id,
    organizationId: app.organizationId,
    trigger: "rollback" as const,
    rollback: { targetDeploymentId: run.previousDeploymentId },
  };
  const rollbackDeploymentId = await createDeployment(opts);
  void requestDeploy({ ...opts, deploymentId: rollbackDeploymentId }).catch((err) =>
    log.error(`Rollback ${rollbackDeploymentId} failed to run:`, err),
  );
  await setUpdateRun({ ...run, state: "rolling-back", rollbackDeploymentId, error: reason });
  log.warn(`${reason}; rolling back as ${rollbackDeploymentId}`);
  await emitToAdmins(failedEvent(run, reason, true));
}

function failedEvent(run: UpdateRun, reason: string, rolledBack: boolean, step = "post-update health check"): BusEvent {
  return {
    type: "system.update-failed",
    title: "Vardo update failed",
    message: rolledBack ? `${reason}. Rolling back.` : reason,
    fromVersion: formatVersion(pkg.version, run.fromSha) ?? pkg.version,
    toVersion: run.toLabel,
    step,
    error: reason,
    rolledBack,
  };
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
      await emitToAdmins(failedEvent(run, `Rollback ${status}; the update is still running`, false, "rollback"));
    }
  }
}

// Auto

async function canaryPeer(instanceId: string | null): Promise<CanaryPeer | null> {
  if (!instanceId) return null;
  const peer = await db.query.meshPeers.findFirst({
    where: eq(meshPeers.instanceId, instanceId),
    columns: { instanceId: true, name: true, vardoSha: true, vardoShaSince: true, vardoHealthy: true, lastSeenAt: true },
  });
  if (!peer) return null;
  return {
    instanceId: peer.instanceId,
    name: peer.name,
    version: peer.vardoSha,
    versionSince: peer.vardoShaSince,
    healthy: peer.vardoHealthy,
    lastSeenAt: peer.lastSeenAt,
  };
}

export async function canaryStatus(policy: UpdatePolicy, targetSha: string, state: UpdateState, now: Date): Promise<CanaryVerdict> {
  return canaryVerdict({
    canary: policy.canary,
    targetSha,
    peer: policy.canary.role === "follower" ? await canaryPeer(policy.canary.canaryInstanceId) : null,
    approvedSha: state.approval?.sha ?? null,
    now,
  });
}

async function notifySkipped(update: ChannelUpdate, failures: GateFailure[], state: UpdateState): Promise<void> {
  const key = failures.map((f) => f.gate).sort().join(",");
  const last = state.lastSkip;
  if (last && sameCommit(last.sha, update.targetSha) && last.key === key && Date.now() - Date.parse(last.at) < SKIP_RENOTIFY_MS) return;
  await updateState((s) => ({ ...s, lastSkip: { sha: update.targetSha, key, at: new Date().toISOString() } }));
  const reasons = failures.map((f) => f.reason);
  log.warn(`Automatic update to ${update.targetLabel} skipped: ${reasons.join("; ")}`);
  await emitToAdmins({
    type: "system.update-skipped",
    title: "Vardo update skipped",
    message: reasons.join("; "),
    fromVersion: currentVersion(),
    target: update.targetLabel,
    reasons,
  });
}

async function autoTick(policy: UpdatePolicy, state: UpdateState, now: Date): Promise<void> {
  const channel = effectiveChannel(policy);
  const update = await getChannelUpdate(channel);
  if (!update?.hasUpdate) return;

  const zone = windowZone(policy.window.timezone, await getInstanceTimezone());
  const decision = decideTick({
    policy,
    hasUpdate: update.hasUpdate,
    selfDeploy: isSelfDeployLayout(),
    runInProgress: false,
    now,
    zone,
    canary: await canaryStatus(policy, update.targetSha, state, now),
  });
  if (decision.action !== "apply") return;

  const failures = evaluateGates(await collectGateInputs(update.targetSha, state));
  if (failures.length > 0) {
    // A target that already failed here waits for a newer one without a notice each window.
    if (failures.every((f) => f.gate === "failed-before")) return;
    await notifySkipped(update, failures, state);
    return;
  }
  try {
    await startUpdate({ trigger: "auto", channel, update });
  } catch (err) {
    if (err instanceof UpdateBlockedError) await notifySkipped(update, [{ gate: "backup", reason: err.message }], state);
    else throw err;
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
  if (!(await acquireLock(LOCK_KEY, LOCK_MS))) return;
  try {
    const state = await trackVersion(await getUpdateState(), now);
    const run = await getUpdateRun();
    if (run && isRunActive(run, now.getTime())) {
      await advanceRun(run, now.getTime());
      return;
    }
    const policy = await getUpdatePolicy();
    if (policy.mode === "auto") await autoTick(policy, state, now);
  } finally {
    await releaseLock(LOCK_KEY).catch(() => {});
  }
}

const globalForUpdates = globalThis as unknown as { __vardo_self_update?: boolean };

export function startSelfUpdateScheduler(): void {
  if (globalForUpdates.__vardo_self_update) return;
  globalForUpdates.__vardo_self_update = true;

  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    tickSelfUpdate()
      .catch((err) => log.warn("Update tick failed:", err))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(tick, 30_000);
  const interval = setInterval(tick, TICK_MS);
  first.unref();
  interval.unref();
  closeOnShutdown(() => {
    clearTimeout(first);
    clearInterval(interval);
  });
}
