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
import { eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { listAllContainers, inspectContainer, type ContainerInfo } from "./client";
import { logger } from "@/lib/logger";
import { memoryLimitDrifted } from "./limit-drift";
import { matchContainers } from "./container-match";
import {
  exitCandidates,
  exitReasonFor,
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
 */
export function deriveStatus(containers: ContainerInfo[]): ObservedStatus {
  if (containers.length === 0) return "missing";
  if (containers.some((c) => c.state === "restarting" || c.state === "dead")) return "error";
  if (containers.some((c) => c.state === "running")) return "active";
  if (containers.some((c) => (parseExitCode(c.status) ?? 0) !== 0)) return "error";
  return "stopped";
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

export async function tickStatusReconcile(): Promise<void> {
  let containers: ContainerInfo[];
  try {
    containers = await listAllContainers();
  } catch (err) {
    log.error("Failed to list containers:", err instanceof Error ? err.message : err);
    return;
  }

  const rows = await db.query.apps.findMany({
    columns: {
      id: true,
      name: true,
      status: true,
      parentAppId: true,
      composeService: true,
      containerName: true,
      importedContainerId: true,
      containerStartedAt: true,
      lastRunningAt: true,
      containerMemoryLimit: true,
      memoryLimit: true,
      needsRedeploy: true,
      exitReason: true,
      updatedAt: true,
    },
  });

  const now = new Date();
  const limit = pLimit(INSPECT_CONCURRENCY);
  const missing: string[] = [];

  const updates = await Promise.all(
    rows.map((app) =>
      limit(async () => {
        // A deploy in flight owns the status until it finishes, or until the
        // hold expires — a stranded "deploying" must not be permanent.
        if (deployHoldsStatus(app, now)) return null;

        const matched = matchContainers(app, containers);
        const observed = deriveStatus(matched);

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
        }

        if (observed === "missing" && app.status !== "missing") missing.push(app.name);

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
          touchOnly: unchanged,
          observed,
          startedAt,
          memoryLimit,
          needsRedeploy,
          exitReason,
          running: observed === "active",
        };
      }),
    ),
  );

  const settled = updates.filter((u) => u !== null);
  const changed = settled.filter((u) => !u.touchOnly);
  const touched = settled.filter((u) => u.touchOnly);

  for (const u of changed) {
    await db
      .update(apps)
      .set({
        status: u.observed,
        containerStartedAt: u.startedAt,
        containerMemoryLimit: u.memoryLimit,
        needsRedeploy: u.needsRedeploy,
        exitReason: u.exitReason,
        // Stamped only while running and never cleared, so it survives the
        // container going away. Idle age is measured from this.
        ...(u.running ? { lastRunningAt: now } : {}),
        statusCheckedAt: now,
        updatedAt: now,
      })
      .where(eq(apps.id, u.id));
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
