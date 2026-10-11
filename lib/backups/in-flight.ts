// Backups, restores, drills and imports in flight, in this process and others, so a stop can wait for them.

import { hostname } from "os";
import { logger } from "@/lib/logger";
import { redis } from "@/lib/redis";
import { backupSlotsBusy } from "./run-limit";

const log = logger.child("backup");

export type BackupWorkKind = "backup" | "restore" | "drill" | "import";

export type BackupWork = { kind: BackupWorkKind; label: string; startedAt: number };

type InFlightState = {
  work: Map<number, BackupWork>;
  seq: number;
  draining: boolean;
  /** Last read of the shared drain flags. */
  remote: { draining: boolean; readAt: number };
  /** Renews this process's shared drain flag. */
  drainTimer: ReturnType<typeof setInterval> | null;
  drainKey: string | null;
};

// Must live on globalThis; Next duplicates module state across bundles.
const globalForWork = globalThis as unknown as { __vardo_backup_work?: InFlightState };
const state: InFlightState = (globalForWork.__vardo_backup_work ??= {
  work: new Map(),
  seq: 0,
  draining: false,
  remote: { draining: false, readAt: 0 },
  drainTimer: null,
  drainKey: null,
});
const globalForBeacon = globalThis as unknown as { __vardo_backup_beat?: () => void };

const BUSY_PREFIX = "backup:busy:";
const BUSY_TTL_MS = 30_000;
const BUSY_BEAT_MS = 5_000;
const DRAIN_TTL_MS = 30_000;
const DRAIN_RENEW_MS = 10_000;

/** A shared drain flag counts this long after its last successful read. */
export const DRAIN_FLAG_FRESH_MS = 30_000;

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

/** Set while a stop of this process, or a self-deploy stopping its slot, waits for backup work: schedules start nothing new. */
export function backupsDraining(now = Date.now()): boolean {
  return state.draining || (state.remote.draining && now - state.remote.readAt < DRAIN_FLAG_FRESH_MS);
}

function describeWork(work: BackupWork[], queued: boolean): string {
  const named = work.map((w) => `${w.kind} ${w.label}`).join(", ");
  return [named, queued ? "jobs queued for a backup slot" : ""].filter(Boolean).join("; ");
}

/** Redis key the watchdog and install.sh read to hold a restart. Host-qualified: web and worker containers share pids. */
export const backupBusyKey = (pid: number = process.pid, host: string = hostname()) => `${BUSY_PREFIX}${host}:${pid}`;

/** Redis flag a self-deploy drain sets: processes in that slot, or every process for `all`, start no new backup work. */
export const backupDrainKey = (slot: string | null) => `backup:drain:${slot ?? "all"}`;

/** Backup work another process reports through its beacon. */
export type OtherBackupWork = { key: string; slot: string | null; work: string };

/** What a beacon value says; values from older releases are plain text. */
export function parseBusyValue(value: string): { slot: string | null; work: string } {
  try {
    const parsed = JSON.parse(value) as { slot?: unknown; work?: unknown } | null;
    if (parsed && typeof parsed === "object" && typeof parsed.work === "string") {
      return { slot: typeof parsed.slot === "string" ? parsed.slot : null, work: parsed.work };
    }
  } catch { /* plain text */ }
  return { slot: null, work: value };
}

/** Other processes' backup work in `slot`, or anywhere for null. A process that doesn't know its slot counts in every slot. */
export async function otherBackupWork(slot: string | null): Promise<OtherBackupWork[]> {
  const own = backupBusyKey();
  const keys = new Set<string>();
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", `${BUSY_PREFIX}*`, "COUNT", 200);
    for (const key of batch) if (key !== own) keys.add(key);
    cursor = next;
  } while (cursor !== "0");
  if (keys.size === 0) return [];
  const list = [...keys];
  const values = await redis.mget(...list);
  return list.flatMap((key, i) => {
    const value = values[i];
    if (value === null || value === undefined) return [];
    const parsed = parseBusyValue(value);
    if (slot !== null && parsed.slot !== null && parsed.slot !== slot) return [];
    return [{ key, ...parsed }];
  });
}

const describeOther = (o: OtherBackupWork) => `${o.work} (${o.key.slice(BUSY_PREFIX.length)})`;

function startSharedDrain(slot: string | null): void {
  stopSharedDrain();
  const key = backupDrainKey(slot);
  state.drainKey = key;
  const renew = () =>
    void redis
      .set(key, String(process.pid), "PX", DRAIN_TTL_MS)
      .catch((err) => log.warn("Couldn't set the backup drain flag:", err instanceof Error ? err.message : err));
  renew();
  state.drainTimer = setInterval(renew, DRAIN_RENEW_MS);
  state.drainTimer.unref?.();
}

function stopSharedDrain(): void {
  if (state.drainTimer) clearInterval(state.drainTimer);
  state.drainTimer = null;
  const key = state.drainKey;
  state.drainKey = null;
  if (key) redis.del(key).catch(() => {});
}

export type DrainScope = {
  /** The slot being stopped: its other processes' work is waited on and their schedules pause. Null for every process. */
  slot: string | null;
};

/**
 * Holds a stop until backup work finishes, up to `timeoutMs`: this process's, and with `scope` other processes' too.
 * Schedules start nothing new meanwhile. Returns what is still running at the deadline.
 */
export async function drainBackupsForStop(
  onLog: (line: string) => void,
  timeoutMs = backupDrainTimeoutMs(),
  pollMs = 1000,
  scope?: DrainScope,
): Promise<string[]> {
  state.draining = true;
  if (scope) startSharedDrain(scope.slot);
  const deadline = Date.now() + timeoutMs;
  let warned = false;
  // Redis down reads as no other work; the deadline and the beacons' TTL bound the wait either way.
  const readOthers = async (): Promise<OtherBackupWork[]> => {
    if (!scope) return [];
    try {
      return await otherBackupWork(scope.slot);
    } catch (err) {
      if (!warned) log.warn("Couldn't read other processes' backup work:", err instanceof Error ? err.message : err);
      warned = true;
      return [];
    }
  };
  let others = await readOthers();
  const localBusy = () => state.work.size > 0 || backupSlotsBusy();
  let said = "";
  while ((localBusy() || others.length > 0) && Date.now() < deadline) {
    const here = localBusy() ? describeWork(backupWorkInFlight(), backupSlotsBusy() && state.work.size === 0) : "";
    const now = [here && `in this process: ${here}`, others.length > 0 && `in other processes: ${others.map(describeOther).join(", ")}`]
      .filter(Boolean)
      .join("; ");
    if (now !== said) {
      onLog(`[deploy] Waiting up to ${Math.round((deadline - Date.now()) / 60_000)} min for backup work ${now}`);
      said = now;
    }
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    others = await readOthers();
  }
  const left = [...backupWorkInFlight().map((w) => `${w.kind} ${w.label}`), ...others.map(describeOther)];
  if (left.length > 0) log.warn(`Stopping with backup work still running: ${left.join(", ")}`);
  else if (said) onLog("[deploy] Backup work finished");
  return left;
}

/** Start schedules again after a stop that didn't happen. */
export function endBackupDrain(): void {
  state.draining = false;
  stopSharedDrain();
}

/** One beacon pass: reports this process's work under its busy key and reads the drain flags for its slot. */
export async function beatBackupWork(slot: string | null, now = Date.now()): Promise<void> {
  const work = backupWorkInFlight();
  if (work.length > 0) {
    await redis.set(backupBusyKey(), JSON.stringify({ slot, work: describeWork(work, false).slice(0, 500) }), "PX", BUSY_TTL_MS);
  } else {
    await redis.del(backupBusyKey());
  }
  const flags = await redis.mget(backupDrainKey(null), ...(slot ? [backupDrainKey(slot)] : []));
  state.remote = { draining: flags.some((f) => f !== null && f !== undefined), readAt: now };
}

/** Keeps this process's busy key set while it has backup work in flight, and follows shared drains. */
export function startBackupWorkBeacon(): void {
  if (globalForBeacon.__vardo_backup_beat) return;
  const beat = async () => {
    const { ownSlot } = await import("@/lib/docker/own-slot");
    await beatBackupWork(await ownSlot());
  };
  globalForBeacon.__vardo_backup_beat = () => void beat().catch(() => {});
  setInterval(globalForBeacon.__vardo_backup_beat, BUSY_BEAT_MS).unref?.();
}

/** Test hook. */
export function resetBackupWorkForTests(): void {
  state.work.clear();
  state.draining = false;
  state.remote = { draining: false, readAt: 0 };
  if (state.drainTimer) clearInterval(state.drainTimer);
  state.drainTimer = null;
  state.drainKey = null;
}
