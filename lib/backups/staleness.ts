// ---------------------------------------------------------------------------
// Backup job staleness
//
// lastRunAt only advances when a run captures something, so a job that has
// quietly stopped producing archives leaves it behind. This turns that into a
// verdict the attention surface can read, without asking why the job stopped.
//
// Pure — no server imports.
// ---------------------------------------------------------------------------

import { Cron } from "croner";

/** Missed runs before a job counts as overdue. One late run is a slow night. */
export const OVERDUE_INTERVALS = 2;

/** Fires sampled to measure an interval. Weekday-only schedules vary by gap. */
const INTERVAL_SAMPLES = 4;

export type ScheduledBackupJob = {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastRunAt: Date | null;
  createdAt: Date;
};

export type OverdueBackupJob = {
  job: ScheduledBackupJob;
  /** Last capture, or when the job was created if it has never captured one. */
  since: Date;
  neverRan: boolean;
};

/**
 * Longest gap between the schedule's next few fires. Null when the expression
 * is unparseable or has no repeat left.
 *
 * The longest rather than the first: `0 2 * * 1-5` runs 24h apart most nights
 * and 72h apart over a weekend, and the shorter gap would call every Monday
 * morning overdue.
 */
export function scheduleIntervalMs(schedule: string, from: Date): number | null {
  if (!schedule.trim()) return null;
  try {
    const runs = new Cron(schedule.trim()).nextRuns(INTERVAL_SAMPLES, from);
    if (runs.length < 2) return null;
    let longest = 0;
    for (let i = 1; i < runs.length; i++) {
      longest = Math.max(longest, runs[i].getTime() - runs[i - 1].getTime());
    }
    return longest > 0 ? longest : null;
  } catch {
    return null;
  }
}

/**
 * Enabled jobs that have captured nothing for OVERDUE_INTERVALS of their own
 * schedule. A job that has never run is measured from when it was created, so
 * one made a minute ago is not overdue before its first fire.
 */
export function overdueBackupJobs(
  jobs: ScheduledBackupJob[],
  now: Date,
): OverdueBackupJob[] {
  const overdue: OverdueBackupJob[] = [];

  for (const job of jobs) {
    if (!job.enabled) continue;
    const interval = scheduleIntervalMs(job.schedule, now);
    if (interval === null) continue;

    const since = job.lastRunAt ?? job.createdAt;
    if (now.getTime() - since.getTime() <= interval * OVERDUE_INTERVALS) continue;

    overdue.push({ job, since, neverRan: job.lastRunAt === null });
  }

  return overdue;
}
