// ---------------------------------------------------------------------------
// Choosing what to drill.
//
// A drill costs a container and a download, so they run on a rotation rather
// than after every backup: pick the archive whose restorability is least
// known, prove that one, come back tomorrow.
//
// Pure — the selection is here, the running is in drill.ts.
// ---------------------------------------------------------------------------

/** One volume's newest successful backup, and what is known about restoring it. */
export type DrillCandidate = {
  backupId: string;
  /** Groups by what the archive is of, so one drill per volume rather than per run. */
  volumeKey: string;
  finishedAt: Date;
  verifiedAt: Date | null;
  verifyOutcome: string | null;
};

/** How long a verification stands before that volume is due again. */
export const DRILL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Order candidates by how much a drill would tell us.
 *
 * Never drilled comes first — an archive nobody has restored is the one whose
 * verdict is unknown. Then a previous failure, because a fix should be
 * confirmed rather than assumed. Then oldest verification.
 */
export function drillPriority(c: DrillCandidate, now: Date): number {
  if (!c.verifiedAt) return 0;
  if (c.verifyOutcome === "failed") return 1;
  return now.getTime() - c.verifiedAt.getTime() >= DRILL_INTERVAL_MS ? 2 : 3;
}

/**
 * Pick the backups to drill this tick, newest archive per volume.
 *
 * Returns at most `limit`, and only candidates that are actually due — a fleet
 * verified this week schedules nothing rather than re-proving what it knows.
 */
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
      // Within a band, the least recently confirmed goes first. An unverified
      // archive has no verification date, so its own age stands in.
      const aAge = a.c.verifiedAt ?? a.c.finishedAt;
      const bAge = b.c.verifiedAt ?? b.c.finishedAt;
      return aAge.getTime() - bAge.getTime();
    })
    .slice(0, limit)
    .map(({ c }) => c);
}
