// Writes Docker's observed container state back to apps.status.

import pLimit from "p-limit";
import { eq, inArray, or, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { setParked } from "@/lib/db/app-parked";
import { apps } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity/record";
import {
  listAllContainers,
  inspectContainer,
  type ContainerInfo,
  type ContainerInspect,
} from "./client";
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
import { tickOomWatch, type OomSubject as OomWatchSubject } from "./oom-watch";
import { closeOnShutdown } from "@/lib/shutdown";

// Re-exported for existing callers.
export { parseExitCode };

const log = logger.child("status-reconcile");

/** How often Docker is polled. */
export const RECONCILE_INTERVAL_MS = 60_000;
/** Concurrent container inspects while resolving start times. */
const INSPECT_CONCURRENCY = 8;

export type ObservedStatus = "active" | "error" | "stopped" | "missing";

/** How long "deploying" is honored before the reconciler takes the status back. */
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

/** Observed status for one app's containers. Pass the exit reason to tell a stop from a 137 crash. */
export function deriveStatus(
  containers: ContainerInfo[],
  reason?: ExitReason | null,
): ObservedStatus {
  if (containers.length === 0) return "missing";
  if (containers.some((c) => c.state === "restarting" || c.state === "dead")) return "error";
  if (containers.some((c) => c.state === "running")) return "active";
  // An OOM kill also arrives as a signal but isn't a stop.
  if (isOomKill(reason)) return "error";
  if (reason?.kind === "signal") return "stopped";
  if (containers.some((c) => (parseExitCode(c.status) ?? 0) !== 0)) return "error";
  return "stopped";
}

/** Skips a fresh stop, whose containers a slightly older Docker read may still show running. */
export const UNPARK_GRACE_MS = 30_000;

/** A stopped-by-operator app whose containers are running again was started outside Vardo. */
export function shouldClearPark(
  app: { parked: boolean; updatedAt: Date | null },
  observed: ObservedStatus,
  now: Date,
  graceMs: number = UNPARK_GRACE_MS,
): boolean {
  if (!app.parked || observed !== "active") return false;
  return !app.updatedAt || now.getTime() - app.updatedAt.getTime() >= graceMs;
}

/** Crash or recovery activity event for a status transition, or null. */
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

/** Coarse span: minutes, hours, then days. */
function formatSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Whether the stored reason still matches what Docker reports. */
export function exitReasonsEqual(a: ExitReason | null, b: ExitReason | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && a.exitCode === b.exitCode && a.containerName === b.containerName;
}

/** One container's restart counter and when it was created. */
export type ContainerRestart = { count: number | null; createdAt: Date | null };

/** Stored restart count and the point it counts from. */
export type StoredRestarts = { count: number | null; since: Date | null };

/**
 * Restart total across containers. Null with no containers (never read null as zero).
 * Keeps the stored figure if any container didn't answer.
 */
export function restartsFor(
  reads: ContainerRestart[],
  stored: StoredRestarts,
): StoredRestarts {
  if (reads.length === 0) return { count: null, since: null };
  if (reads.some((r) => r.count === null)) return stored;

  const created = reads.flatMap((r) => (r.createdAt ? [r.createdAt.getTime()] : []));
  return {
    count: reads.reduce((total, r) => total + (r.count ?? 0), 0),
    since: created.length === 0 ? null : new Date(Math.min(...created)),
  };
}

/** One inspect per container per pass. */
type InspectCache = (id: string) => Promise<ContainerInspect>;

function inspectCache(): InspectCache {
  const seen = new Map<string, Promise<ContainerInspect>>();
  return (id) => {
    let pending = seen.get(id);
    if (!pending) {
      pending = inspectContainer(id);
      seen.set(id, pending);
    }
    return pending;
  };
}

/** Restart count and creation time per container, null if it didn't answer. */
function readRestarts(
  matched: ContainerInfo[],
  inspect: InspectCache,
): Promise<ContainerRestart[]> {
  return Promise.all(
    matched.map(async (c) => {
      try {
        const info = await inspect(c.id);
        const created = new Date(info.createdAt);
        return {
          count: info.restartCount,
          createdAt: isNaN(created.getTime()) ? null : created,
        };
      } catch {
        return { count: null, createdAt: null };
      }
    }),
  );
}

/**
 * Why this app's containers are down, from State.OOMKilled and the exit code.
 * Docker clears OOMKilled on start, so only a poller of stopped containers can see it.
 */
async function resolveExitReason(
  matched: ContainerInfo[],
  now: Date,
  inspect: InspectCache,
): Promise<ExitReason | null> {
  const reasons: ExitReason[] = [];
  for (const c of exitCandidates(matched)) {
    try {
      const info = await inspect(c.id);
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
      // Container went away between list and inspect.
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
  restarts: { count: number | null };
};

/** One notification per OOM kill. */
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
      path: "exit",
      restartCount: s.restarts.count,
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
  parked: true,
  parentAppId: true,
  composeService: true,
  containerName: true,
  importedContainerId: true,
  statusChangedAt: true,
  containerStartedAt: true,
  lastRunningAt: true,
  containerMemoryLimit: true,
  containerRestartCount: true,
  containerRestartSince: true,
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
async function computeAppUpdate(
  app: ReconcileApp,
  containers: ContainerInfo[],
  now: Date,
  inspect: InspectCache,
) {
  // An in-flight deploy owns the status until the hold expires.
  if (deployHoldsStatus(app, now)) return null;

  const matched = matchContainers(app, containers);
  let observed = deriveStatus(matched);

  const restarts = restartsFor(await readRestarts(matched, inspect), {
    count: app.containerRestartCount,
    since: app.containerRestartSince,
  });

  let startedAt: Date | null = null;
  let memoryLimit: number | null = null;
  let exitReason: ExitReason | null = null;
  let oomSubject: OomWatchSubject | null = null;
  if (observed === "active") {
    const running = matched.find((c) => c.state === "running");
    if (running) {
      try {
        const info = await inspect(running.id);
        const parsed = new Date(info.state.startedAt);
        if (!isNaN(parsed.getTime())) startedAt = parsed;
        memoryLimit = info.memoryBytes;
      } catch {
        // Container went away between list and inspect.
        startedAt = app.containerStartedAt;
        memoryLimit = app.containerMemoryLimit;
      }
      exitReason = reasonSurvivesRestart(app.exitReason, { id: running.id, startedAt }, now);
      oomSubject = {
        organizationId: app.organizationId,
        appId: app.id,
        appName: app.displayName || app.name,
        containerId: running.id,
        containerName: running.name,
        memoryLimit: memoryLimit ?? 0,
      };
    }
  } else {
    exitReason = await resolveExitReason(matched, now, inspect);
    observed = deriveStatus(matched, exitReason);
  }

  // Flag a configured memory limit the container isn't running with.
  const drifted = memoryLimitDrifted(app.memoryLimit, memoryLimit);
  const needsRedeploy = drifted || !!app.needsRedeploy;

  const unchanged =
    observed === app.status &&
    startedAt?.getTime() === app.containerStartedAt?.getTime() &&
    memoryLimit === app.containerMemoryLimit &&
    restarts.count === app.containerRestartCount &&
    restarts.since?.getTime() === app.containerRestartSince?.getTime() &&
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
    restarts,
    needsRedeploy,
    exitReason,
    running: observed === "active",
    clearPark: shouldClearPark(app, observed, now),
    stability: unchanged
      ? null
      : stabilityTransition({
          from: app.status,
          to: observed,
          reason: exitReason,
          heldMs: app.statusChangedAt ? now.getTime() - app.statusChangedAt.getTime() : null,
        }),
    oomFirstSeen: isOomKill(exitReason) && !exitReasonsEqual(exitReason, app.exitReason),
    oomSubject,
  };
}

type AppUpdate = NonNullable<Awaited<ReturnType<typeof computeAppUpdate>>>;

/** Write an observed status to the row. */
async function applyAppUpdate(u: AppUpdate, now: Date): Promise<void> {
  await db
    .update(apps)
    .set({
      ...statusChange(u.observed, now),
      containerStartedAt: u.startedAt,
      containerMemoryLimit: u.memoryLimit,
      containerRestartCount: u.restarts.count,
      containerRestartSince: u.restarts.since,
      needsRedeploy: u.needsRedeploy,
      exitReason: u.exitReason,
      // Never cleared; idle age is measured from it.
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

/** Reconcile one app and its compose children now. Returns its observed status, or null on failure. */
export async function reconcileAppNow(appId: string): Promise<ObservedStatus | null> {
  try {
    const containers = await listAllContainers();
    const rows = await loadReconcileRows(
      or(eq(apps.id, appId), eq(apps.parentAppId, appId)),
    );

    const now = new Date();
    const inspect = inspectCache();
    let observed: ObservedStatus | null = null;
    for (const app of rows) {
      const update = await computeAppUpdate(app, containers, now, inspect);
      if (!update) continue;
      if (app.id === appId) observed = update.observed;
      if (!update.touchOnly) await applyAppUpdate(update, now);
      if (update.clearPark) await setParked(app.id, false, now);
    }
    return observed;
  } catch (err) {
    // Best-effort; the periodic tick corrects it.
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
  const inspect = inspectCache();

  const updates = await Promise.all(
    rows.map((app) => limit(() => computeAppUpdate(app, containers, now, inspect))),
  );

  const settled = updates.filter((u) => u !== null);
  const changed = settled.filter((u) => !u.touchOnly);
  const touched = settled.filter((u) => u.touchOnly);
  const missing = settled.filter((u) => u.becameMissing).map((u) => u.name);

  for (const u of changed) {
    await applyAppUpdate(u, now);
  }
  for (const u of settled) {
    if (u.clearPark) await setParked(u.id, false, now);
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

  // Every running container, not only changed ones.
  try {
    await tickOomWatch(settled.flatMap((u) => (u.oomSubject ? [u.oomSubject] : [])));
  } catch (err) {
    log.error("OOM counter check failed:", err);
  }

  if (missing.length > 0) {
    log.error(
      `${missing.length} registered app(s) have no container on this host: ${missing.join(", ")}`,
    );
  }
  if (changed.length > 0) {
    log.info(`Reconciled ${changed.length} app status(es) against Docker`);
  }
}

let interval: NodeJS.Timeout | null = null;
let ticking = false;
let unregisterShutdown: (() => void) | null = null;

export function startStatusReconciler(): void {
  if (interval) return;

  log.info(`Reconciler started (${RECONCILE_INTERVAL_MS / 1000}s interval)`);
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

  // Run once shortly after startup.
  setTimeout(tick, 5_000);
  interval = setInterval(tick, RECONCILE_INTERVAL_MS);

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
