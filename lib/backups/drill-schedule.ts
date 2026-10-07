// Drill rotation: pick the archives whose restorability is least known.

/** One volume's newest successful backup, and what is known about restoring it. */
export type DrillCandidate = {
  backupId: string;
  /** Groups by source, so one drill per volume. */
  volumeKey: string;
  finishedAt: Date;
  verifiedAt: Date | null;
  verifyOutcome: string | null;
};

/** How long a verification stands before that volume is due again. */
export const DRILL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Order candidates: never drilled, then previously failed, then oldest verification. */
export function drillPriority(c: DrillCandidate, now: Date): number {
  if (!c.verifiedAt) return 0;
  if (c.verifyOutcome === "failed") return 1;
  return now.getTime() - c.verifiedAt.getTime() >= DRILL_INTERVAL_MS ? 2 : 3;
}

/** Pick up to `limit` due backups to drill, newest archive per volume. */
export function selectDrillCandidates(
  candidates: DrillCandidate[],
  now: Date,
  limit: number,
): DrillCandidate[] {
  const newestPerVolume = new Map<string, DrillCandidate>();
  for (const c of candidates) {
    const held = newestPerVolume.get(c.volumeKey);
    if (!held || c.finishedAt.getTime() > held.finishedAt.getTime()) {
      newestPerVolume.set(c.volumeKey, c);
    }
  }

  return [...newestPerVolume.values()]
    .map((c) => ({ c, priority: drillPriority(c, now) }))
    .filter(({ priority }) => priority < 3)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      // Least recently confirmed first. An unverified archive uses its own age.
      const aAge = a.c.verifiedAt ?? a.c.finishedAt;
      const bAge = b.c.verifiedAt ?? b.c.finishedAt;
      return aAge.getTime() - bAge.getTime();
    })
    .slice(0, limit)
    .map(({ c }) => c);
}
