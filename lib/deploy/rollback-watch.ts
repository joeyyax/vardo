// ---------------------------------------------------------------------------
// Auto-rollback grace period.
//
// The window is derived from the deployment row on every sweep rather than held
// in a timer, so a Vardo restart mid-window resumes the watch instead of losing
// it. This module is the pure decision half; the sweeper does the IO.
// ---------------------------------------------------------------------------

import { isSelfApp } from "@/lib/docker/self-env";

/** Widest window the sweep scans. Matches the API's rollbackGracePeriod cap. */
export const MAX_GRACE_PERIOD_SECONDS = 600;

/** Applied when an app has autoRollback on but no explicit grace period. */
export const DEFAULT_GRACE_PERIOD_SECONDS = 60;

export type Slot = "blue" | "green";

export type WatchCandidate = {
  appName: string;
  /** apps.status at read time. */
  appStatus: string;
  /** deployment.slot — "local" and null are not blue-green. */
  slot: string | null;
  finishedAt: Date | null;
  gracePeriodSeconds: number | null;
  /** Whether a later deployment row exists for this app. */
  superseded: boolean;
};

export type WatchVerdict =
  | { watch: false; reason: string }
  | { watch: true; slot: Slot; standbySlot: Slot };

/** The slot a rollback would restore. */
export function otherSlot(slot: Slot): Slot {
  return slot === "blue" ? "green" : "blue";
}

/**
 * Whether a successful deployment is still inside its grace period and safe to
 * act on. Everything here is re-derived per sweep — no verdict is remembered.
 */
export function evaluateWatch(c: WatchCandidate, now: number): WatchVerdict {
  // The watch would run inside the container a rollback tears down, and cannot
  // observe its own death. Reported at deploy time, never armed.
  if (isSelfApp(c.appName)) return { watch: false, reason: "self-deploy" };

  if (c.slot !== "blue" && c.slot !== "green") {
    return { watch: false, reason: "not a blue-green deploy" };
  }
  if (!c.finishedAt) return { watch: false, reason: "no finish time" };
  if (c.superseded) return { watch: false, reason: "superseded by a later deploy" };
  if (c.appStatus !== "active") return { watch: false, reason: `app is ${c.appStatus}` };

  const grace = clampGracePeriod(c.gracePeriodSeconds);
  if (now >= c.finishedAt.getTime() + grace * 1000) {
    return { watch: false, reason: "grace period elapsed" };
  }

  return { watch: true, slot: c.slot, standbySlot: otherSlot(c.slot) };
}

/** Bound a stored grace period to the range the API accepts. */
export function clampGracePeriod(seconds: number | null): number {
  if (seconds == null || !Number.isFinite(seconds)) return DEFAULT_GRACE_PERIOD_SECONDS;
  return Math.min(Math.max(Math.trunc(seconds), 1), MAX_GRACE_PERIOD_SECONDS);
}
