// This host's worker and watchdog as web sees them: incidents when either goes quiet.

import { stat } from "fs/promises";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { syncHostProblem } from "@/lib/incidents/host";
import { logger } from "@/lib/logger";
import { WATCHDOG_ALIVE_FILE } from "@/lib/system-alerts/watchdog-events";
import { IntervalLoop } from "./interval-loop";
import { HANDOFF_CHECK_MS, WATCHDOG_SILENT_AFTER_MS, WORKER_DOWN_AFTER_MS, workerExpected } from "./mode";
import { readWorkers, summarizeWorkers, type WorkerSummary } from "./presence";

const log = logger.child("worker-watch");

/** The loop whose heartbeat stands for the console: it ticks in every web process. */
export const CONSOLE_BEAT_LOOP = "worker-handoff";

/** The watchdog's last tick, or null when it isn't running here or is disabled. */
export async function watchdogAliveAt(file = WATCHDOG_ALIVE_FILE): Promise<Date | null> {
  try {
    return (await stat(file)).mtime;
  } catch {
    return null;
  }
}

export type HostHeartbeats = WorkerSummary & { consoleAt: Date | null; watchdogAt: Date | null; now: Date };

async function consoleBeatAt(): Promise<Date | null> {
  const rows = await db.execute<{ at: string | Date | null }>(
    sql`SELECT max(last_tick_at) AS at FROM job_heartbeat WHERE name = ${CONSOLE_BEAT_LOOP}`,
  );
  const at = rows[0]?.at;
  return at ? new Date(at) : null;
}

/** This host's console, worker and watchdog heartbeats, on the database clock. */
export async function readHostHeartbeats(): Promise<HostHeartbeats> {
  const [{ now, rows }, consoleAt, watchdogAt] = await Promise.all([readWorkers(), consoleBeatAt(), watchdogAliveAt()]);
  return { ...summarizeWorkers(rows, now), consoleAt, watchdogAt, now };
}

/** No worker heartbeat for WORKER_DOWN_AFTER_MS. A worker never seen counts from `since`. */
export function workerDown(workerAt: Date | null, now: Date, since: Date): boolean {
  const last = workerAt ?? since;
  return now.getTime() - last.getTime() > WORKER_DOWN_AFTER_MS;
}

/** The watchdog has ticked here before and stopped. */
export function watchdogSilent(watchdogAt: Date | null, now: Date): boolean {
  return !!watchdogAt && now.getTime() - watchdogAt.getTime() > WATCHDOG_SILENT_AFTER_MS;
}

const bootedAt = new Date();

export async function workerWatchPass(): Promise<void> {
  const host = await readHostHeartbeats();
  if (workerExpected()) {
    const down = workerDown(host.workerAt, host.now, bootedAt);
    const changed = await syncHostProblem(
      {
        kind: "host.worker-down",
        about: "host",
        title: "Background worker is down",
        message: "No heartbeat from vardo-worker for 3 minutes. Scheduled work runs in the console until it's back. Check `vardo worker status`.",
        severity: "critical",
      },
      down,
      "The background worker is running again.",
    );
    if (changed !== "unchanged") log.info(`host.worker-down ${changed}`);
  }
  const silent = watchdogSilent(host.watchdogAt, new Date());
  await syncHostProblem(
    {
      kind: "host.watchdog-silent",
      about: "host",
      title: "Watchdog stopped checking",
      message: "vardo-watchdog hasn't ticked in 10 minutes, so nothing restarts an unhealthy console, worker or database. Check `docker ps --filter name=vardo-watchdog`.",
      severity: "warning",
    },
    silent,
    "The watchdog is checking again.",
  );
}

export const workerWatchLoop = new IntervalLoop({
  name: "worker-watch",
  intervalMs: HANDOFF_CHECK_MS,
  log,
  run: () => workerWatchPass(),
});
