import type { MetricsPoint } from "./types";

/** Poll cadence while the stream is not connected. */
export const METRICS_FALLBACK_MS = 10_000;

/** Wait before reopening a stream the browser has given up on, doubling per attempt. */
export function streamRetryMs(attempt: number): number {
  return Math.min(15_000 * 2 ** Math.max(attempt, 0), 120_000);
}

/** Append polled points newer than the last one held, inside the window and under the cap. */
export function mergePolledPoints(
  prev: MetricsPoint[],
  polled: MetricsPoint[],
  cutoff: number,
  max: number,
): MetricsPoint[] {
  const last = prev.length > 0 ? prev[prev.length - 1].timestamp : -Infinity;
  const fresh = polled.filter((p) => p.timestamp > last).sort((a, b) => a.timestamp - b.timestamp);
  if (fresh.length === 0) return prev;
  const inRange = [...prev, ...fresh].filter((p) => p.timestamp >= cutoff);
  return inRange.length > max ? inRange.slice(-max) : inRange;
}

/** Chart points after a history response: the body's on success, what is held on a refusal such as a 429. */
export function pointsAfterHistory(
  prev: MetricsPoint[],
  res: { ok: boolean; body: { points?: MetricsPoint[] } | null },
): MetricsPoint[] {
  return res.ok ? (res.body?.points ?? []) : prev;
}
