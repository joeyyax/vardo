// When a deploy waiting in a line (deploy slots, the builder) should start, from what runs and what's ahead of it.

/** A run longer than this counts as this long. */
export const MAX_TYPICAL_MS = 60 * 60_000;
/** An estimate further out than this isn't shown. */
export const MAX_ETA_MS = 6 * 60 * 60_000;
/** An estimate that moved less than this isn't written again. */
export const ETA_STEP_MS = 30_000;

/** When a slot frees: now when idle, `since` plus a typical run when busy, null when the run has no history. */
export function slotFreeAt(now: number, since: number, typicalMs: number | null): number | null {
  if (typicalMs === null) return null;
  return Math.max(now, since + Math.min(typicalMs, MAX_TYPICAL_MS));
}

/**
 * Each place's start in a line served by `slots` (when each frees): the next in line takes the earliest free slot for its typical run.
 * Null from the first place that depends on a run without history, and past MAX_ETA_MS.
 */
export function lineEtas(now: number, slots: (number | null)[], typicalMs: (number | null)[]): (number | null)[] {
  const free = [...slots];
  let known = free.length > 0 && free.every((s) => s !== null);
  return typicalMs.map((typical) => {
    if (!known) return null;
    let i = 0;
    for (let j = 1; j < free.length; j++) if (free[j]! < free[i]!) i = j;
    const at = free[i]!;
    if (typical === null) known = false;
    else free[i] = at + Math.min(typical, MAX_TYPICAL_MS);
    return at - now > MAX_ETA_MS ? null : at;
  });
}

/** Whether an estimate changed enough to write. */
export function etaMoved(before: Date | string | number | null | undefined, after: number | null): boolean {
  const prev = before == null ? null : new Date(before).getTime();
  if (prev === null || after === null) return prev !== after;
  return Math.abs(prev - after) > ETA_STEP_MS;
}
