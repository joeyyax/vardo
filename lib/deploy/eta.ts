// When a deploy waiting in a line (deploy slots, the builder) should start.

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

/** Each place's start in a line served by `slots` (when each frees). Null from the first run without history, and past MAX_ETA_MS. */
export function lineEtas(now: number, slots: (number | null)[], typicalMs: (number | null)[]): (number | null)[] {
  return pooledLineEtas(
    now,
    slots.map((at) => ({ at, local: true })),
    typicalMs.map((typical) => ({ typicalMs: typical, any: true })),
  );
}

/** As lineEtas, where a place with `any` false takes only slots marked `local`. Null for a place no slot can take. */
export function pooledLineEtas(
  now: number,
  slots: { at: number | null; local: boolean }[],
  places: { typicalMs: number | null; any: boolean }[],
): (number | null)[] {
  const free = slots.map((s) => s.at);
  let known = free.length > 0 && free.every((s) => s !== null);
  return places.map(({ typicalMs: typical, any }) => {
    if (!known) return null;
    let i = -1;
    for (let j = 0; j < free.length; j++) if ((any || slots[j].local) && (i === -1 || free[j]! < free[i]!)) i = j;
    if (i === -1) return null;
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
