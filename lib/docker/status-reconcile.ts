// ---------------------------------------------------------------------------
// App status reconciliation
//
// apps.status is written only by the deploy engine, so it records what Vardo
// was last told to do rather than what Docker is actually running. An app whose
// container was removed outside Vardo stays "active" forever. This module polls
// Docker and writes the observed state back, including "missing" for a
// registered app with no container at all.
// ---------------------------------------------------------------------------

import pLimit from "p-limit";
import { eq, inArray, or, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { apps } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity/record";
import { listAllContainers, inspectContainer, type ContainerInfo } from "./client";
import { logger } from "@/lib/logger";
import { memoryLimitDrifted } from "./limit-drift";
import { matchContainers } from "./container-match";
import {
  exitCandidates,
  exitReasonFor,
  isOomKill,
  parseExitCode,
  reasonSurvivesRestart,
  worstExitReason,
  type ExitReason,
} from "./exit-reason";
import { closeOnShutdown } from "@/lib/shutdown";

// Lives with the exit classifier it feeds; re-exported for the callers that
// have always read it from here.
export { parseExitCode };

const log = logger.child("status-reconcile");

const POLL_INTERVAL_MS = 60_000;
/** Concurrent container inspects while resolving start times. */
const INSPECT_CONCURRENCY = 8;

export type ObservedStatus = "active" | "error" | "stopped" | "missing";

// ---------------------------------------------------------------------------
// Pure decision logic (unit tested)
// ---------------------------------------------------------------------------

/**
 * How long "deploying" is honored before the reconciler takes the status back.
 * Well past the deploy timeout the sweeper enforces, so this only ever catches
 * a status the sweeper could not reset — a process killed mid-deploy.
 */
export const DEPLOYING_HOLD_MS =
  (Number(process.env.DEPLOY_TIMEOUT_MINUTES) || 15) * 60_000 * 4;

/** Whether an in-flight deploy still owns this app's status. */
export function deployHoldsStatus(
  app: { status: string; updatedAt?: Date | null },
  now: Date,
  holdMs: number = DEPLOYING_HOLD_MS,
): boolean {
  if (app.status !== "deploying") return false;
  if (!app.updatedAt) return false;
  return now.getTime() - app.updatedAt.getTime() < holdMs;
}

/**
 * Observed status for one app's containers.
 * "restarting" reads as error — a container flapping is not running.
 *
 * Without a reason the exit code decides, which reads every 137 as a crash.
 * Pass the reason resolved from the same inspect to tell a stop apart from one.
 */
export function deriveStatus(
  containers: ContainerInfo[],
  reason?: ExitReason | null,
): ObservedStatus {
  if (containers.length === 0) return "missing";
  if (containers.some((c) => c.state === "restarting" || c.state === "dead")) return "error";
  if (containers.some((c) => c.state === "running")) return "active";
  // A signal exit is a stop that took SIGTERM or outran its grace period. An
  // OOM kill also arrives as a signal and is not one.
  if (isOomKill(reason)) return "error";
  if (reason?.kind === "signal") return "stopped";
  if (containers.some((c) => (parseExitCode(c.status) ?? 0) !== 0)) return "error";
  return "stopped";
}

/**
 * The durable stability event a status transition earns, or null when it earns
 * none. apps.status only ever holds the current value and Docker's restart
 * counter resets with the container, so a crash leaves no trace unless it is
 * written to the activity log as it happens.
 */
export function stabilityTransition(opts: {
  from: string;
  to: ObservedStatus;
  reason: ExitReason | null;
  /** How long the previous status had held, for the recovery summary. */
  heldMs: number | null;
}): { action: "app.crashed" | "app.recovered"; summary: string } | null {
  if (opts.to === "error" && opts.from !== "error") {
    return { action: "app.crashed", summary: crashSummary(opts.reason) };
  }
  if (opts.to === "active" && opts.from === "error") {
    const down = opts.heldMs !== null && opts.heldMs > 0 ? ` after ${formatSpan(opts.heldMs)} down` : "";
    return { action: "app.recovered", summary: `Running again${down}` };
  }
  return null;
}

function crashSummary(reason: ExitReason | null): string {
  if (!reason) return "Container is restarting or dead";
  switch (reason.kind) {
    case "oom-host":
      return "Killed by the host's OOM killer";
    case "oom-limit":
      return "Killed at its own memory limit";
    case "signal":
      return `Took ${reason.signal} and exited ${reason.exitCode}`;
    case "failed":
      return `Exited with code ${reason.exitCode}`;
  }
}

/** Coarse span for a summary sentence — minutes up to a day, then days. */
function formatSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Whether the stored reason still describes what Docker reports, so a settled app skips its write. */
export function exitReasonsEqual(a: ExitReason | null, b: ExitReason | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && a.exitCode === b.exitCode && a.containerName === b.containerName;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

/**
 * Why this app's containers are down. Only containers that ended badly are
 * inspected — State.OOMKilled is the one field that tells an OOM kill apart
 * from an ordinary stop, and the list API does not carry it.
 *
 * Docker clears State.OOMKilled when a container starts, so a poller that
 * watches running containers can never read it. This reconciler lists stopped
 * ones, which is why the signal lives here and not in the health monitor.
 */
async function resolveExitReason(
  matched: ContainerInfo[],
  now: Date,
): Promise<ExitReason | null> {
  const reasons: ExitReason[] = [];
  for (const c of exitCandidates(matched)) {
    try {
      const info = await inspectContainer(c.id);
      const reason = exitReasonFor(
        {
          containerId: c.id,
          containerName: c.name,
          oomKilled: info.state.oomKilled,
          exitCode: info.state.exitCode,
          memoryLimit: info.memoryBytes,
          finishedAt: info.state.finishedAt,
        },
        now,
      );
      if (reason) reasons.push(reason);
    } catch {
      // Container went away between list and inspect — nothing left to explain.
    }
  }
  return worstExitReason(reasons);
}

type OomSubject = {
  id: string;
  organizationId: string;
  appName: string;
  exitReason: ExitReason | null;
  oomFirstSeen: boolean;
};

/** One notification per kill. This is the only poller that can see an OOM at all. */
async function reportOomKills(subjects: OomSubject[]): Promise<void> {
  const killed = subjects.flatMap((s) =>
    s.oomFirstSeen && s.exitReason ? [{ ...s, reason: s.exitReason }] : [],
  );
  if (killed.length === 0) return;

  const { emit } = await import("@/lib/notifications/dispatch");
  for (const { reason, ...s } of killed) {
    const host = reason.kind === "oom-host";
    log.error(`OOM kill: ${reason.containerName} (app ${s.appName}, ${reason.kind})`);
    emit(s.organizationId, {
      type: "app.oom-killed",
      title: host ? `Killed for host memory: ${s.appName}` : `Killed at memory limit: ${s.appName}`,
      message: host
        ? `The host ran out of memory and the kernel killed ${reason.containerName}, which has no memory limit of its own. Free memory on the host, or give this app a limit so it is not the kernel's choice next time.`
        : `${reason.containerName} was killed at its own memory limit. Raise the limit, or find out what is using more than it was given.`,
      appId: s.id,
      appName: s.appName,
      containerName: reason.containerName,
      containerId: reason.containerId,
      kind: host ? "oom-host" : "oom-limit",
      exitCode: reason.exitCode,
      at: reason.at,
    });
  }
}

const RECONCILE_COLUMNS = {
  id: true,
  name: true,
  displayName: true,
  organizationId: true,
  status: true,
  parentAppId: true,
  composeService: true,
  containerName: true,
  importedContainerId: true,
  statusChangedAt: true,
  containerStartedAt: true,
  lastRunningAt: true,
  containerMemoryLimit: true,
  memoryLimit: true,
  needsRedeploy: true,
  exitReason: true,
  updatedAt: true,
} as const;

function loadReconcileRows(where?: SQL) {
  return db.query.apps.findMany({ columns: RECONCILE_COLUMNS, where });
}

type ReconcileApp = Awaited<ReturnType<typeof loadReconcileRows>>[number];

/** What one app's row should say, measured against what Docker reports. */
async function computeAppUpdate(app: ReconcileApp, containers: ContainerInfo[], now: Date) {
  // A deploy in flight owns the status until it finishes, or until the
  // hold expires — a stranded "deploying" must not be permanent.
  if (deployHoldsStatus(app, now)) return null;

  const matched = matchContainers(app, containers);
  let observed = deriveStatus(matched);

  let startedAt: Date | null = null;
  let memoryLimit: number | null = null;
  let exitReason: ExitReason | null = null;
  if (observed === "active") {
    const running = matched.find((c) => c.state === "running");
    if (running) {
      try {
        const info = await inspectContainer(running.id);
        const parsed = new Date(info.state.startedAt);
        if (!isNaN(parsed.getTime())) startedAt = parsed;
        memoryLimit = info.memoryBytes;
      } catch {
        // Container went away between list and inspect — keep the old values.
        startedAt = app.containerStartedAt;
        memoryLimit = app.containerMemoryLimit;
      }
      exitReason = reasonSurvivesRestart(app.exitReason, { id: running.id, startedAt }, now);
    }
  } else {
    exitReason = await resolveExitReason(matched, now);
    // Re-read with the reason the same inspect produced: a deliberate
    // stop is not a crash, and only the reason can say which this was.
    observed = deriveStatus(matched, exitReason);
  }

  // A configured limit the container is not running is a redeploy away
  // from being real, and nothing else notices the difference.
  const drifted = memoryLimitDrifted(app.memoryLimit, memoryLimit);
  const needsRedeploy = drifted || !!app.needsRedeploy;

  const unchanged =
    observed === app.status &&
    startedAt?.getTime() === app.containerStartedAt?.getTime() &&
    memoryLimit === app.containerMemoryLimit &&
    needsRedeploy === !!app.needsRedeploy &&
    exitReasonsEqual(exitReason, app.exitReason);

  return {
    id: app.id,
    name: app.name,
    organizationId: app.organizationId,
    appName: app.displayName || app.name,
    touchOnly: unchanged,
    becameMissing: observed === "missing" && app.status !== "missing",
    observed,
    startedAt,
    memoryLimit,
    needsRedeploy,
    exitReason,
    running: observed === "active",
    stability: unchanged
      ? null
      : stabilityTransition({
          from: app.status,
          to: observed,
          reason: exitReason,
          heldMs: app.statusChangedAt ? now.getTime() - app.statusChangedAt.getTime() : null,
        }),
    // A kill already reported is not news on every tick that follows it.
    oomFirstSeen: isOomKill(exitReason) && !exitReasonsEqual(exitReason, app.exitReason),
  };
}

type AppUpdate = NonNullable<Awaited<ReturnType<typeof computeAppUpdate>>>;

/** The only place an observed status reaches the row. */
async function applyAppUpdate(u: AppUpdate, now: Date): Promise<void> {
  await db
    .update(apps)
    .set({
      ...statusChange(u.observed, now),
      containerStartedAt: u.startedAt,
      containerMemoryLimit: u.memoryLimit,
      needsRedeploy: u.needsRedeploy,
      exitReason: u.exitReason,
      // Stamped only while running and never cleared, so it survives the
      // container going away. Idle age is measured from this.
      ...(u.running ? { lastRunningAt: now } : {}),
      statusCheckedAt: now,
    })
    .where(eq(apps.id, u.id));

  if (u.stability) {
    try {
      await recordActivity({
        organizationId: u.organizationId,
        appId: u.id,
        action: u.stability.action,
        metadata: { summary: u.stability.summary, status: u.observed },
      });
    } catch (err) {
      log.error(`Failed to record ${u.stability.action} for ${u.id}:`, err);
    }
  }
}

/**
 * Re-read one app and its compose children from Docker now, instead of leaving
 * the row describing containers that have already been replaced.
 *
 * Restart and recreate change nothing the row records, so until this runs the
 * page shows the old start time and the action reads as a no-op. Bringing a
 * stopped app back up is worse — the badge still says stopped. Routes call this
 * rather than writing the row themselves, so status keeps one writer.
 *
 * Returns what Docker says the app is now, or null when it could not be read.
 */
export async function reconcileAppNow(appId: string): Promise<ObservedStatus | null> {
  try {
    const containers = await listAllContainers();
    const rows = await loadReconcileRows(
      or(eq(apps.id, appId), eq(apps.parentAppId, appId)),
    );

    const now = new Date();
    let observed: ObservedStatus | null = null;
    for (const app of rows) {
      const update = await computeAppUpdate(app, containers, now);
      if (!update) continue;
      if (app.id === appId) observed = update.observed;
      if (!update.touchOnly) await applyAppUpdate(update, now);
    }
    return observed;
  } catch (err) {
    // Best-effort: the periodic tick still corrects the row within the minute.
    log.error(`Failed to reconcile ${appId} on demand:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function tickStatusReconcile(): Promise<void> {
  let containers: ContainerInfo[];
  try {
    containers = await listAllContainers();
  } catch (err) {
    log.error("Failed to list containers:", err instanceof Error ? err.message : err);
    return;
  }

  const rows = await loadReconcileRows();

  const now = new Date();
  const limit = pLimit(INSPECT_CONCURRENCY);

  const updates = await Promise.all(
    rows.map((app) => limit(() => computeAppUpdate(app, containers, now))),
  );

  const settled = updates.filter((u) => u !== null);
  const changed = settled.filter((u) => !u.touchOnly);
  const touched = settled.filter((u) => u.touchOnly);
  const missing = settled.filter((u) => u.becameMissing).map((u) => u.name);

  for (const u of changed) {
    await applyAppUpdate(u, now);
  }

  const touchedRunning = touched.filter((u) => u.running).map((u) => u.id);
  const touchedIdle = touched.filter((u) => !u.running).map((u) => u.id);

  if (touchedRunning.length > 0) {
    await db
      .update(apps)
      .set({ statusCheckedAt: now, lastRunningAt: now })
      .where(inArray(apps.id, touchedRunning));
  }
  if (touchedIdle.length > 0) {
    await db.update(apps).set({ statusCheckedAt: now }).where(inArray(apps.id, touchedIdle));
  }

  await reportOomKills(changed);

  if (missing.length > 0) {
    log.error(
      `${missing.length} registered app(s) have no container on this host: ${missing.join(", ")}`,
    );
  }
  if (changed.length > 0) {
    log.info(`Reconciled ${changed.length} app status(es) against Docker`);
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let interval: NodeJS.Timeout | null = null;
let ticking = false;
let unregisterShutdown: (() => void) | null = null;

export function startStatusReconciler(): void {
  if (interval) return;

  log.info(`Reconciler started (${POLL_INTERVAL_MS / 1000}s interval)`);
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tickStatusReconcile();
    } catch (err) {
      log.error("Tick error:", err);
    } finally {
      ticking = false;
    }
  };

  // Run once at startup so a stale "active" doesn't survive until the first interval.
  setTimeout(tick, 5_000);
  interval = setInterval(tick, POLL_INTERVAL_MS);

  // Registered from the start function, not at module scope — importing this
  // module must not wire a shutdown for a reconciler that was never started.
  unregisterShutdown = closeOnShutdown(stopStatusReconciler);
}

export function stopStatusReconciler(): void {
  unregisterShutdown?.();
  unregisterShutdown = null;
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Reconciler stopped");
  }
}
