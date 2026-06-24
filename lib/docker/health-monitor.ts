import { db } from "@/lib/db";
import { listContainers, inspectContainer, restartContainer } from "./client";
import { emit } from "@/lib/notifications/dispatch";
import { logger } from "@/lib/logger";

const log = logger.child("health-monitor");

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000;
/** Consecutive ticks a container must read "unhealthy" before we act. Docker's
 *  own healthcheck retries already gate the unhealthy state; this is an extra
 *  guard against a single racy read. */
export const CONFIRM_STREAK = 2;
/** Don't restart the same container more often than this. */
export const RESTART_BACKOFF_MS = 5 * 60_000;
/** Rolling window for the restart cap. */
export const RESTART_WINDOW_MS = 60 * 60_000;
/** Max restarts of one container within RESTART_WINDOW_MS before we give up and
 *  escalate to a human instead of looping forever. */
export const MAX_RESTARTS_PER_WINDOW = 5;
/** Skip containers younger than this — the post-deploy rollback monitor owns the
 *  fresh-deploy window, and Docker reports "starting" (not "unhealthy") during a
 *  healthcheck's start_period anyway. */
const MIN_CONTAINER_AGE_MS = 120_000;

// ---------------------------------------------------------------------------
// Pure decision logic (unit tested)
// ---------------------------------------------------------------------------

export type RestartDecision = "wait" | "restart" | "backoff" | "giveup";

/**
 * Decide what to do about a container currently reading "unhealthy".
 * Pure function of the accumulated state so it can be tested in isolation.
 *
 * @param streak           consecutive unhealthy reads including this tick
 * @param recentRestarts   restart timestamps within RESTART_WINDOW_MS, ascending
 * @param now              current epoch ms
 */
export function decideRestart(opts: {
  streak: number;
  recentRestarts: number[];
  now: number;
}): RestartDecision {
  if (opts.streak < CONFIRM_STREAK) return "wait";
  if (opts.recentRestarts.length >= MAX_RESTARTS_PER_WINDOW) return "giveup";
  const last = opts.recentRestarts[opts.recentRestarts.length - 1];
  if (last !== undefined && opts.now - last < RESTART_BACKOFF_MS) return "backoff";
  return "restart";
}

/** Whether an app should be auto-restarted when unhealthy. null on the app means
 *  "use the default", which is on for critical-priority apps and off otherwise. */
export function effectiveAutoRestart(app: {
  autoRestartUnhealthy: boolean | null;
  priority: string | null;
}): boolean {
  return app.autoRestartUnhealthy ?? app.priority === "critical";
}

// ---------------------------------------------------------------------------
// Per-container in-memory state
// ---------------------------------------------------------------------------

const unhealthyStreak = new Map<string, number>();
/** containerId → restart timestamps within the rolling window (ascending). */
const restartHistory = new Map<string, number[]>();
/** containerIds we've already escalated as "gave up" — alert once per window. */
const gaveUp = new Set<string>();

function prune(ts: number[], now: number): number[] {
  return ts.filter((t) => now - t < RESTART_WINDOW_MS);
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export async function tickHealthMonitor(): Promise<void> {
  const now = Date.now();

  let containers;
  try {
    // listContainers() returns running containers only — exactly the set whose
    // healthcheck state is meaningful.
    containers = await listContainers();
  } catch (err) {
    // Transient Docker socket error — skip this tick, never throw.
    log.error("Failed to list containers:", err instanceof Error ? err.message : err);
    return;
  }

  const managed = containers.filter((c) => c.labels["vardo.managed"] === "true");
  const seen = new Set<string>();

  // Load the apps referenced by these containers once, keyed by id.
  const appIds = [...new Set(managed.map((c) => c.labels["vardo.project.id"]).filter(Boolean))];
  if (appIds.length === 0) {
    cleanupState(seen);
    return;
  }

  const appRows = await db.query.apps.findMany({
    columns: {
      id: true,
      name: true,
      displayName: true,
      priority: true,
      autoRestartUnhealthy: true,
      organizationId: true,
    },
    where: (t, { inArray }) => inArray(t.id, appIds),
  });
  const appsById = new Map(appRows.map((a) => [a.id, a]));

  for (const c of managed) {
    seen.add(c.id);

    const app = appsById.get(c.labels["vardo.project.id"]);
    if (!app) continue;
    if (!effectiveAutoRestart(app)) {
      unhealthyStreak.delete(c.id);
      continue;
    }

    let info;
    try {
      info = await inspectContainer(c.id);
    } catch {
      continue; // container may have just gone away
    }

    // No healthcheck → we can't judge health; nothing to do.
    if (!info.state.health) {
      unhealthyStreak.delete(c.id);
      continue;
    }

    if (info.state.health.status !== "unhealthy") {
      // healthy / starting → reset and clear any prior give-up escalation
      unhealthyStreak.delete(c.id);
      gaveUp.delete(c.id);
      continue;
    }

    // Skip very young containers (post-deploy window owned by rollback monitor).
    const age = now - new Date(info.state.startedAt).getTime();
    if (Number.isFinite(age) && age < MIN_CONTAINER_AGE_MS) continue;

    const streak = (unhealthyStreak.get(c.id) ?? 0) + 1;
    unhealthyStreak.set(c.id, streak);

    const history = prune(restartHistory.get(c.id) ?? [], now);
    restartHistory.set(c.id, history);

    const decision = decideRestart({ streak, recentRestarts: history, now });

    if (decision === "wait" || decision === "backoff") continue;

    const appName = app.displayName || app.name;

    if (decision === "giveup") {
      if (gaveUp.has(c.id)) continue; // already escalated this window
      gaveUp.add(c.id);
      log.error(
        `${c.name} unhealthy and hit the restart cap (${MAX_RESTARTS_PER_WINDOW}/${RESTART_WINDOW_MS / 60000}m) — giving up`,
      );
      emit(app.organizationId, {
        type: "app.auto-restarted",
        title: `Self-heal gave up: ${appName}`,
        message: `${c.name} has been unhealthy and was auto-restarted ${MAX_RESTARTS_PER_WINDOW} times in the last hour without recovering. Auto-restart is paused for this container — manual intervention required.`,
        appId: app.id,
        appName,
        containerName: c.name,
        containerId: c.id,
        reason: "unhealthy",
        success: false,
        gaveUp: true,
      });
      continue;
    }

    // decision === "restart"
    let ok = true;
    try {
      await restartContainer(c.id);
      log.info(`Restarted unhealthy container ${c.name} (app ${appName})`);
    } catch (err) {
      ok = false;
      log.error(`Failed to restart ${c.name}:`, err instanceof Error ? err.message : err);
    }

    history.push(now);
    restartHistory.set(c.id, history);
    unhealthyStreak.delete(c.id);

    emit(app.organizationId, {
      type: "app.auto-restarted",
      title: ok ? `Auto-restarted: ${appName}` : `Auto-restart failed: ${appName}`,
      message: ok
        ? `${c.name} was unhealthy and has been automatically restarted (${history.length}/${MAX_RESTARTS_PER_WINDOW} restarts this hour).`
        : `${c.name} was unhealthy but the automatic restart command failed. Manual intervention may be required.`,
      appId: app.id,
      appName,
      containerName: c.name,
      containerId: c.id,
      reason: "unhealthy",
      success: ok,
      gaveUp: false,
    });
  }

  cleanupState(seen);
}

/** Drop in-memory state for containers that no longer exist. */
function cleanupState(seen: Set<string>): void {
  for (const id of unhealthyStreak.keys()) if (!seen.has(id)) unhealthyStreak.delete(id);
  for (const id of restartHistory.keys()) if (!seen.has(id)) restartHistory.delete(id);
  for (const id of gaveUp) if (!seen.has(id)) gaveUp.delete(id);
}

// ---------------------------------------------------------------------------
// Scheduler (mirrors lib/system-alerts/monitor.ts)
// ---------------------------------------------------------------------------

let interval: NodeJS.Timeout | null = null;
let ticking = false;

export function startHealthMonitor(): void {
  if (interval) return;

  log.info(`Monitor started (${POLL_INTERVAL_MS / 1000}s interval)`);
  interval = setInterval(async () => {
    if (ticking) {
      log.warn("Previous tick still running — skipping");
      return;
    }
    ticking = true;
    try {
      await tickHealthMonitor();
    } catch (err) {
      log.error("Tick error:", err);
    } finally {
      ticking = false;
    }
  }, POLL_INTERVAL_MS);
}

export function stopHealthMonitor(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Monitor stopped");
  }
}

function onShutdown(signal: string) {
  log.info(`Received ${signal} — stopping monitor`);
  stopHealthMonitor();
}

process.once("SIGTERM", () => onShutdown("SIGTERM"));
process.once("SIGINT", () => onShutdown("SIGINT"));
process.once("exit", () => stopHealthMonitor());
