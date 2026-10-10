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
