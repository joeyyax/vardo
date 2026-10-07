// Backup job staleness: jobs whose lastRunAt has fallen behind their schedule.

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

/** Longest gap between the schedule's next few fires, so weekday schedules span weekends. Null if unparseable. */
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

/** Enabled jobs that have captured nothing for OVERDUE_INTERVALS of their schedule. */
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
