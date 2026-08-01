import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps as appsTable } from "@/lib/db/schema";
import { listContainers, inspectContainer, restartContainer } from "./client";
import { fetchAllMetrics } from "@/lib/metrics/provider";
import { emit } from "@/lib/notifications/dispatch";
import {
  evaluateConditions,
  conditionsEqual,
  type AppCondition,
  type ConditionInput,
  type ConditionStreaks,
} from "./conditions";
import { loadAdvisoryInputs, type AdvisoryInput } from "./condition-inputs";
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

/** Restarts observed within RESTART_WINDOW_MS before a container counts as
 *  crash-looping. Override with VARDO_CRASH_LOOP_RESTARTS. */
export function getCrashLoopThreshold(): number {
  const parsed = parseInt(process.env.VARDO_CRASH_LOOP_RESTARTS ?? "5", 10);
  return Math.max(2, isNaN(parsed) ? 5 : parsed);
}

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

/**
 * Whether a container is crash-looping: Docker's RestartCount has climbed past
 * the threshold since we started watching, and we never once saw the container
 * healthy.
 *
 * This is the failure class the unhealthy check cannot see. A container that
 * dies inside its healthcheck's start_period never leaves "starting", so its
 * FailingStreak stays 0 and it reads as fine forever while Docker restarts it
 * on a loop.
 */
export function isCrashLooping(opts: {
  restartsSinceBaseline: number;
  everHealthy: boolean;
  threshold: number;
}): boolean {
  if (opts.everHealthy) return false;
  return opts.restartsSinceBaseline >= opts.threshold;
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
/** containerId → Docker RestartCount when we first saw it, and when. */
const restartBaseline = new Map<string, { count: number; at: number }>();
/** containerIds observed healthy at least once — not crash-looping. */
const everHealthy = new Set<string>();
/** containerId → last crash-loop alert, so we escalate once per window. */
const crashLoopAlerted = new Map<string, number>();
/** appId → hysteresis streaks, fed back into evaluateConditions each tick. */
const conditionStreaks = new Map<string, ConditionStreaks>();

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
      conditions: true,
    },
    where: (t, { inArray }) => inArray(t.id, appIds),
  });
  const appsById = new Map(appRows.map((a) => [a.id, a]));

  // One cAdvisor read for the whole fleet, keyed by the container id the loop
  // below already has.
  // cAdvisor reports the 12-char short id; Docker's list API returns the full
  // one. Both sides are truncated so the lookup matches.
  const usageByContainer = new Map<string, { usage: number; limit: number }>();
  try {
    for (const m of await fetchAllMetrics()) {
      usageByContainer.set(shortId(m.containerId), { usage: m.memoryUsage, limit: m.memoryLimit });
    }
  } catch (err) {
    log.warn("Metrics unavailable, skipping memory conditions:", err instanceof Error ? err.message : err);
  }

  /** Worst signal seen across each app's containers this tick. */
  const signals = new Map<string, ConditionInput>();
  const noteSignal = (appId: string, patch: Partial<ConditionInput>) => {
    const cur = signals.get(appId) ?? emptySignal(now);
    signals.set(appId, {
      ...cur,
      ...patch,
      // An app is crash-looping or unhealthy if any of its containers is.
      crashLoop: patch.crashLoop ?? cur.crashLoop,
      health: patch.health === "unhealthy" || cur.health === "unhealthy" ? "unhealthy" : (patch.health ?? cur.health),
      selfHealExhausted: patch.selfHealExhausted || cur.selfHealExhausted,
      memory:
        patch.memory && (!cur.memory || memRatio(patch.memory) > memRatio(cur.memory))
          ? patch.memory
          : cur.memory,
    });
  };

  for (const c of managed) {
    seen.add(c.id);

    const app = appsById.get(c.labels["vardo.project.id"]);
    if (!app) continue;

    let info;
    try {
      info = await inspectContainer(c.id);
    } catch {
      continue; // container may have just gone away
    }

    if (info.state.health?.status === "healthy") everHealthy.add(c.id);
    checkCrashLoop(c, info.restartCount, app, now);

    noteSignal(app.id, {
      health: normalizeHealth(info.state.health?.status),
      crashLoop: crashLoopSignal(c.id, info.restartCount, now),
      selfHealExhausted: gaveUp.has(c.id),
      memory: usageByContainer.get(shortId(c.id)) ?? null,
    });

    if (!effectiveAutoRestart(app)) {
      unhealthyStreak.delete(c.id);
      continue;
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

  const advisories = await loadAdvisoryInputs(now);
  await persistConditions(appRows, signals, advisories, now, usageByContainer.size);
  cleanupState(seen);
}

function emptySignal(now: number): ConditionInput {
  return {
    now,
    crashLoop: null,
    health: null,
    selfHealExhausted: false,
    memory: null,
    security: null,
    backup: null,
  };
}

function shortId(id: string): string {
  return id.slice(0, 12);
}

function normalizeHealth(status: string | undefined): ConditionInput["health"] {
  return status === "healthy" || status === "unhealthy" || status === "starting" ? status : null;
}

function memRatio(m: { usage: number; limit: number }): number {
  return m.limit > 0 ? m.usage / m.limit : 0;
}

/**
 * Crash-loop input for one container, or null when it is not looping. Mirrors
 * isCrashLooping — restarts since the baseline, never having reported healthy.
 */
function crashLoopSignal(
  containerId: string,
  restartCount: number,
  now: number,
): ConditionInput["crashLoop"] {
  const baseline = restartBaseline.get(containerId);
  if (!baseline) return null;
  const delta = restartCount - baseline.count;
  if (
    !isCrashLooping({
      restartsSinceBaseline: delta,
      everHealthy: everHealthy.has(containerId),
      threshold: getCrashLoopThreshold(),
    })
  ) {
    return null;
  }
  return { restarts: delta, windowMs: now - baseline.at };
}

/** One line on the first tick, so an evaluator that reads nothing is visible
 *  rather than indistinguishable from one that found nothing wrong. */
let conditionsReported = false;

/** Evaluate and write conditions for every app the tick saw. */
async function persistConditions(
  appRows: { id: string; conditions: AppCondition[] | null }[],
  signals: Map<string, ConditionInput>,
  advisories: Map<string, AdvisoryInput>,
  now: number,
  sampleCount: number,
): Promise<void> {
  if (!conditionsReported) {
    conditionsReported = true;
    const withMetrics = [...signals.values()].filter((s) => s.memory && s.memory.limit > 0).length;
    log.info(
      `Evaluating conditions for ${appRows.length} app(s); ${sampleCount} container metric sample(s), ${withMetrics} with a memory limit to measure against`,
    );
  }

  for (const app of appRows) {
    const advisory = advisories.get(app.id);
    const input: ConditionInput = {
      ...(signals.get(app.id) ?? emptySignal(now)),
      security: advisory?.security ?? null,
      backup: advisory?.backup ?? null,
    };
    const prev = app.conditions ?? [];
    const { conditions, streaks } = evaluateConditions(
      input,
      prev,
      conditionStreaks.get(app.id) ?? {},
    );
    conditionStreaks.set(app.id, streaks);

    if (conditionsEqual(prev, conditions)) continue;
    try {
      await db
        .update(appsTable)
        .set({ conditions: conditions.length > 0 ? conditions : null })
        .where(eq(appsTable.id, app.id));
    } catch (err) {
      log.error(`Failed to write conditions for ${app.id}:`, err);
    }
  }
}

/**
 * Escalate a container whose RestartCount keeps climbing without ever reaching
 * healthy. Alerts at most once per RESTART_WINDOW_MS, then rebaselines so a
 * container that is still looping alerts again next window.
 */
function checkCrashLoop(
  c: { id: string; name: string },
  restartCount: number,
  app: { id: string; name: string; displayName: string | null; organizationId: string },
  now: number,
): void {
  const baseline = restartBaseline.get(c.id);
  if (!baseline || restartCount < baseline.count) {
    // First sighting, or the container was recreated and the counter reset.
    restartBaseline.set(c.id, { count: restartCount, at: now });
    return;
  }

  if (now - baseline.at > RESTART_WINDOW_MS) {
    restartBaseline.set(c.id, { count: restartCount, at: now });
    return;
  }

  const threshold = getCrashLoopThreshold();
  const delta = restartCount - baseline.count;
  if (!isCrashLooping({ restartsSinceBaseline: delta, everHealthy: everHealthy.has(c.id), threshold })) {
    return;
  }

  const lastAlert = crashLoopAlerted.get(c.id);
  if (lastAlert !== undefined && now - lastAlert < RESTART_WINDOW_MS) return;
  crashLoopAlerted.set(c.id, now);
  restartBaseline.set(c.id, { count: restartCount, at: now });

  const appName = app.displayName || app.name;
  const perHour = Math.round((delta / (now - baseline.at)) * 3_600_000);
  log.error(
    `CRASH LOOP: ${c.name} (app ${appName}) restarted ${delta} time(s) in ${Math.round((now - baseline.at) / 60000)}m ` +
      `(~${perHour}/hr, ${restartCount} total) and has never reported healthy — it is dying before its healthcheck can fail`,
  );

  emit(app.organizationId, {
    type: "app.auto-restarted",
    title: `Crash loop: ${appName}`,
    message:
      `${c.name} has restarted ${delta} time(s) in the last ${Math.round((now - baseline.at) / 60000)} minutes ` +
      `(~${perHour}/hr) and has never reached a healthy state. Docker keeps restarting it, so it never reports ` +
      `unhealthy and self-heal cannot see it. Check the container logs — this needs manual intervention.`,
    appId: app.id,
    appName,
    containerName: c.name,
    containerId: c.id,
    reason: "crash-loop",
    success: false,
    gaveUp: true,
  });
}

/** Drop in-memory state for containers that no longer exist. */
function cleanupState(seen: Set<string>): void {
  for (const id of unhealthyStreak.keys()) if (!seen.has(id)) unhealthyStreak.delete(id);
  for (const id of restartHistory.keys()) if (!seen.has(id)) restartHistory.delete(id);
  for (const id of gaveUp) if (!seen.has(id)) gaveUp.delete(id);
  for (const id of restartBaseline.keys()) if (!seen.has(id)) restartBaseline.delete(id);
  for (const id of everHealthy) if (!seen.has(id)) everHealthy.delete(id);
  for (const id of crashLoopAlerted.keys()) if (!seen.has(id)) crashLoopAlerted.delete(id);
}

/** Drop streaks for apps that no longer exist. Keyed by app, not container. */
export function forgetConditionStreaks(appIds: Set<string>): void {
  for (const id of conditionStreaks.keys()) if (!appIds.has(id)) conditionStreaks.delete(id);
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
