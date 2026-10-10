// Canary ordering across linked instances. A follower takes a version once an admin approves it
// or the canary has run it healthy for the soak period.

import type { CanaryPolicy } from "./policy";

/** What a peer last reported over the mesh heartbeat. */
export type CanaryPeer = {
  instanceId: string;
  name: string;
  /** Commit the peer runs. */
  version: string | null;
  /** When it started running that commit. */
  versionSince: Date | null;
  healthy: boolean | null;
  lastSeenAt: Date | null;
};

export type CanaryVerdict = { ready: true; reason: string } | { ready: false; reason: string };

/** A peer quiet for longer than this is offline. */
export const CANARY_STALE_MS = 10 * 60_000;

export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const n = Math.min(x.length, y.length);
  return n >= 7 && x.slice(0, n) === y.slice(0, n);
}

function hours(ms: number): string {
  const h = ms / 3_600_000;
  return h >= 10 ? `${Math.floor(h)}h` : `${Math.floor(h * 10) / 10}h`;
}

export function canaryVerdict(input: {
  canary: CanaryPolicy;
  targetSha: string;
  peer: CanaryPeer | null;
  approvedSha: string | null;
  now: Date;
}): CanaryVerdict {
  const { canary, targetSha, peer, approvedSha, now } = input;
  if (canary.role !== "follower") return { ready: true, reason: "No canary to wait on" };
  if (sameCommit(approvedSha, targetSha)) return { ready: true, reason: "Approved by an admin" };
  if (!peer) return { ready: false, reason: "Waiting for approval: the canary instance isn't linked" };

  const name = peer.name;
  if (!peer.lastSeenAt || now.getTime() - peer.lastSeenAt.getTime() > CANARY_STALE_MS) {
    return { ready: false, reason: `Waiting for approval: ${name} is offline` };
  }
  if (!sameCommit(peer.version, targetSha)) {
    return { ready: false, reason: `Waiting for ${name} to run ${targetSha.slice(0, 7)}` };
  }
  if (peer.healthy === false) return { ready: false, reason: `Waiting: ${name} is unhealthy on ${targetSha.slice(0, 7)}` };
  if (peer.healthy === null || !peer.versionSince) {
    return { ready: false, reason: `Waiting for approval: ${name} doesn't report its health` };
  }

  const soakMs = canary.soakHours * 3_600_000;
  const ran = now.getTime() - peer.versionSince.getTime();
  if (ran < soakMs) {
    return { ready: false, reason: `Waiting: ${name} has run ${targetSha.slice(0, 7)} for ${hours(ran)} of ${canary.soakHours}h` };
  }
  return { ready: true, reason: `${name} ran it healthy for ${hours(ran)}` };
}
