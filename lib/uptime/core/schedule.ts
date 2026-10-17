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

/** Due once per interval, at the monitor's own offset into it. */
export function isDue(id: string, intervalSec: number, last: number | undefined, now: number): boolean {
  const interval = intervalSec * 1000;
  const phase = phaseOf(id, interval);
  if (last === undefined) return true;
  return Math.floor((now - phase) / interval) > Math.floor((last - phase) / interval);
}
