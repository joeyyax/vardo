// What an instance tells its mesh peers about its own Vardo on each heartbeat, for canary ordering.

import { getBuildSha } from "@/lib/version";

export type VardoStatus = {
  sha: string;
  /** ISO time this instance started running `sha`. */
  since: string | null;
  healthy: boolean | null;
};

const SHA_RE = /^[0-9a-f]{7,40}$/i;

// Set by the update scheduler each tick, so a heartbeat never waits on the database.
// On globalThis: the scheduler and the heartbeat route load separate copies of this module.
const globalForStatus = globalThis as unknown as {
  __vardo_local_status?: { since: string | null; healthy: boolean | null };
};

export function setLocalVardoStatus(status: { since: string | null; healthy: boolean | null }): void {
  globalForStatus.__vardo_local_status = { since: status.since, healthy: status.healthy };
}

export function localVardoStatus(): VardoStatus | null {
  const sha = getBuildSha().trim();
  if (!SHA_RE.test(sha)) return null;
  const local = globalForStatus.__vardo_local_status;
  return { sha, since: local?.since ?? null, healthy: local?.healthy ?? null };
}

/** A peer's report, or null when it sent none or sent nonsense. */
export function parseVardoStatus(raw: unknown): VardoStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sha !== "string" || !SHA_RE.test(r.sha)) return null;
  const since = typeof r.since === "string" && !Number.isNaN(Date.parse(r.since)) ? new Date(r.since).toISOString() : null;
  return { sha: r.sha.toLowerCase(), since, healthy: typeof r.healthy === "boolean" ? r.healthy : null };
}

/** An instance's console, worker and watchdog heartbeats, ISO times on its own clock. */
export type HostStatus = {
  consoleAt: string | null;
  workerAt: string | null;
  workerReady: boolean | null;
  watchdogAt: string | null;
};

/** This instance's heartbeats, or null when they can't be read. */
export async function localHostStatus(): Promise<HostStatus | null> {
  try {
    const { readHostHeartbeats } = await import("@/lib/worker/watch");
    const h = await readHostHeartbeats();
    return {
      consoleAt: h.consoleAt?.toISOString() ?? null,
      workerAt: h.workerAt?.toISOString() ?? null,
      workerReady: h.workerAt ? h.workerReady : null,
      watchdogAt: h.watchdogAt?.toISOString() ?? null,
    };
  } catch {
    return null;
  }
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** A peer's heartbeats, or null when it sent none. */
export function parseHostStatus(raw: unknown): HostStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    consoleAt: isoOrNull(r.consoleAt),
    workerAt: isoOrNull(r.workerAt),
    workerReady: typeof r.workerReady === "boolean" ? r.workerReady : null,
    watchdogAt: isoOrNull(r.watchdogAt),
  };
}

/** mesh_peer columns for a peer's heartbeats. Empty when it sent none, so an older peer's row keeps what it had. */
export function hostStatusColumns(status: HostStatus | null): {
  consoleAt?: Date | null;
  workerAt?: Date | null;
  workerReady?: boolean | null;
  watchdogAt?: Date | null;
} {
  if (!status) return {};
  const date = (iso: string | null) => (iso ? new Date(iso) : null);
  return {
    consoleAt: date(status.consoleAt),
    workerAt: date(status.workerAt),
    workerReady: status.workerReady,
    watchdogAt: date(status.watchdogAt),
  };
}

/** mesh_peer columns for a report. Empty when there's none, so an older peer's row keeps what it had. */
export function vardoStatusColumns(status: VardoStatus | null): {
  vardoSha?: string;
  vardoShaSince?: Date | null;
  vardoHealthy?: boolean | null;
} {
  if (!status) return {};
  return {
    vardoSha: status.sha,
    vardoShaSince: status.since ? new Date(status.since) : null,
    vardoHealthy: status.healthy,
  };
}
