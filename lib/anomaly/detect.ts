// Whether one signal has strayed from its baseline long enough to alert.

import type { AlertSeverity } from "@/lib/notifications/registry";
import { highMark, type BucketStats, type Sample } from "./baseline";
import { SENSITIVITY_FLOOR, SENSITIVITY_K, type Sensitivity, type SignalDef } from "./signals";

export type Line = {
  /** Median for this hour. */
  typical: number;
  /** Top of the normal range. */
  high: number;
  /** Over this for the sustain window fires. */
  threshold: number;
  /** An open episode holds until readings stay under this. */
  clearBelow: number;
};

export type SignalVerdict = {
  fires: boolean;
  holds: boolean;
  severity: AlertSeverity;
  value: number;
  /** Start of the run over the line, or the latest reading when there isn't one. */
  since: number;
  line: Line;
};

/** A reading older than this says nothing about now. */
export const STALE_MS = 3 * 60_000;
/** An episode stays open until readings stay under the clear line this long. */
export const RESOLVE_MS = 10 * 60_000;
/** Allowed gap between the window's start and its first reading. */
const COVERAGE_SLACK_MS = 90_000;
/** This many times the line is critical for any signal. */
const CRITICAL_RATIO = 3;

/** max(k × high, high + floor), with k and the floor set by sensitivity and the signal's weight. */
export function lineFor(signal: SignalDef, stats: BucketStats, sensitivity: Sensitivity): Line {
  const high = highMark(stats);
  const k = Math.max(1.2, SENSITIVITY_K[sensitivity] * signal.weight);
  const floor = signal.floor * SENSITIVITY_FLOOR[sensitivity];
  const threshold = Math.max(k * high, high + floor);
  return { typical: stats.median, high, threshold, clearBelow: Math.max(high + floor / 2, threshold * 0.75) };
}

/** Null without a fresh reading, so the caller neither fires nor clears. */
export function judgeSignal(points: Sample[], signal: SignalDef, line: Line, now: number): SignalVerdict | null {
  const latest = points.at(-1);
  if (!latest || now - latest.at > STALE_MS) return null;

  const start = now - signal.sustainMs;
  const covered = points[0].at <= start + COVERAGE_SLACK_MS;
  const window = points.filter((p) => p.at > start);
  const fires = covered && window.length > 0 && window.every((p) => p.value > line.threshold);
  const holds = fires || points.some((p) => p.at > now - RESOLVE_MS && p.value >= line.clearBelow);

  let since = latest.at;
  for (let i = points.length - 1; i >= 0 && points[i].value > line.threshold; i--) since = points[i].at;

  const low = Math.min(...window.map((p) => p.value));
  const severity: AlertSeverity = signal.key === "egress" || low >= CRITICAL_RATIO * line.threshold ? "critical" : "warning";
  return { fires, holds, severity, value: latest.value, since, line };
}
