// Threshold rules over a series of readings: a minimum duration to fire, a lower line to clear.

import type { AlertSeverity } from "@/lib/notifications/registry";

export type Point = { at: number; value: number };

export type ThresholdRule = {
  warn: number;
  critical: number;
  /** Holds until the latest reading drops below this. */
  clearBelow: number;
  /** Every reading in this window must be over `warn` to fire. 0 fires on one reading. */
  sustainMs: number;
};

export type Verdict = {
  /** Over the line for the whole window. */
  fires: boolean;
  /** Still above the clear line. */
  holds: boolean;
  severity: AlertSeverity;
  /** Latest reading. */
  value: number;
};

/** A reading older than this says nothing about now. */
export const STALE_MS = 3 * 60_000;

/** Allowed gap between the window's start and the first reading in it. */
const COVERAGE_SLACK_MS = 90_000;

/** Null when there's no fresh reading, so the caller neither fires nor clears. */
export function judgeThreshold(points: Point[], rule: ThresholdRule, now: number, opts: { waiveSustain?: boolean } = {}): Verdict | null {
  const latest = points.at(-1);
  if (!latest || now - latest.at > STALE_MS) return null;

  const instant = rule.sustainMs === 0 || opts.waiveSustain === true;
  const start = now - rule.sustainMs;
  const covered = instant || points[0].at <= start + COVERAGE_SLACK_MS;
  const window = instant ? [latest] : points.filter((p) => p.at > start);
  const low = Math.min(...window.map((p) => p.value));

  const fires = covered && low >= rule.warn;
  return {
    fires,
    holds: fires || latest.value >= rule.clearBelow,
    severity: low >= rule.critical ? "critical" : "warning",
    value: latest.value,
  };
}
