// Backups, restores, drills and imports running in this process, so a stop of the console can wait for them.

import { logger } from "@/lib/logger";
import { backupSlotsBusy } from "./run-limit";

const log = logger.child("backup");

export type BackupWorkKind = "backup" | "restore" | "drill" | "import";

export type BackupWork = { kind: BackupWorkKind; label: string; startedAt: number };

type InFlightState = { work: Map<number, BackupWork>; seq: number; draining: boolean };

// Must live on globalThis; Next duplicates module state across bundles.
const globalForWork = globalThis as unknown as { __vardo_backup_work?: InFlightState };
const state: InFlightState = (globalForWork.__vardo_backup_work ??= { work: new Map(), seq: 0, draining: false });
const globalForBeacon = globalThis as unknown as { __vardo_backup_beat?: () => void };

/** Upper bound on how long a stop of this console waits for backup work. */
export function backupDrainTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const minutes = Number(env.VARDO_BACKUP_DRAIN_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 0 ? minutes : 20) * 60_000;
}

/** Registers `fn` as in-flight backup work until it settles. */
export async function trackBackupWork<T>(kind: BackupWorkKind, label: string, fn: () => Promise<T>): Promise<T> {
  const id = ++state.seq;
  state.work.set(id, { kind, label, startedAt: Date.now() });
  globalForBeacon.__vardo_backup_beat?.();
  try {
    return await fn();
  } finally {
    state.work.delete(id);
    globalForBeacon.__vardo_backup_beat?.();
  }
}

export function backupWorkInFlight(): BackupWork[] {
  return [...state.work.values()];
}

/** Set while a stop of this console waits for backup work: schedules start nothing new. */
export function backupsDraining(): boolean {
  return state.draining;
}

function describeWork(work: BackupWork[], queued: boolean): string {
  const named = work.map((w) => `${w.kind} ${w.label}`).join(", ");
  return [named, queued ? "jobs queued for a backup slot" : ""].filter(Boolean).join("; ");
}

/**
 * Holds a stop of this console until its backup work finishes, up to `timeoutMs`. Schedules start nothing new
 * meanwhile. Returns what is still running at the deadline.
 */
export async function drainBackupsForStop(
  onLog: (line: string) => void,
  timeoutMs = backupDrainTimeoutMs(),
  pollMs = 1000,
): Promise<string[]> {
  state.draining = true;
  const deadline = Date.now() + timeoutMs;
  const busy = () => state.work.size > 0 || backupSlotsBusy();
  let said = "";
  while (busy() && Date.now() < deadline) {
    const now = describeWork(backupWorkInFlight(), backupSlotsBusy() && state.work.size === 0);
    if (now !== said) {
      onLog(`[deploy] Waiting up to ${Math.round((deadline - Date.now()) / 60_000)} min for backup work in this process: ${now}`);
      said = now;
    }
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  const left = backupWorkInFlight().map((w) => `${w.kind} ${w.label}`);
  if (left.length > 0) log.warn(`Stopping with backup work still running: ${left.join(", ")}`);
  else if (said) onLog("[deploy] Backup work finished");
  return left;
}

/** Start schedules again after a stop that didn't happen. */
export function endBackupDrain(): void {
  state.draining = false;
}

/** Redis key the watchdog and install.sh read to hold a console restart. */
export const backupBusyKey = (pid: number = process.pid) => `backup:busy:${pid}`;

const BUSY_TTL_MS = 30_000;
const BUSY_BEAT_MS = 10_000;

/** Keeps `backup:busy:<pid>` set while this process has backup work in flight. */
export function startBackupWorkBeacon(): void {
  if (globalForBeacon.__vardo_backup_beat) return;
  const beat = async () => {
    const { redis } = await import("@/lib/redis");
    const work = backupWorkInFlight();
    if (work.length > 0) {
      await redis.set(backupBusyKey(), describeWork(work, false).slice(0, 500), "PX", BUSY_TTL_MS);
    } else {
      await redis.del(backupBusyKey());
    }
  };
  globalForBeacon.__vardo_backup_beat = () => void beat().catch(() => {});
  setInterval(globalForBeacon.__vardo_backup_beat, BUSY_BEAT_MS).unref?.();
}

/** Test hook. */
export function resetBackupWorkForTests(): void {
  state.work.clear();
  state.draining = false;
}
