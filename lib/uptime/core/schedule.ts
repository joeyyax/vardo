// When each monitor runs: once per interval at its own offset, so checks don't all start together.

/** A stable offset into the interval per monitor, so checks spread out instead of starting together. */
export function phaseOf(id: string, intervalMs: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) % intervalMs;
}

/** Due once per period, at `offsetMs` into it. */
export function isDueAt(periodMs: number, offsetMs: number, last: number | undefined, now: number): boolean {
  if (last === undefined) return true;
  return Math.floor((now - offsetMs) / periodMs) > Math.floor((last - offsetMs) / periodMs);
}

/** Due once per interval, at the monitor's own offset into it. */
export function isDue(id: string, intervalSec: number, last: number | undefined, now: number): boolean {
  const interval = intervalSec * 1000;
  return isDueAt(interval, phaseOf(id, interval), last, now);
}

/**
 * One vantage point's schedule when `vantageIds` (this one included) all check a monitor. Each checks every interval x N,
 * at the monitor's phase plus its place in the sorted ids times the interval, so the monitor is checked about once per interval in all.
 */
export function staggerOf(monitorId: string, intervalSec: number, vantageIds: string[], self: string): { periodSec: number; offsetMs: number } {
  const ids = [...new Set([...vantageIds, self])].sort();
  const interval = intervalSec * 1000;
  return { periodSec: intervalSec * ids.length, offsetMs: phaseOf(monitorId, interval) + ids.indexOf(self) * interval };
}

/** How often each vantage point checks when `watchers` of them (local included) share a monitor. Staleness and coverage use this, not the monitor's interval. */
export const effectiveIntervalSec = (intervalSec: number, watchers: number): number => intervalSec * Math.max(1, watchers);
