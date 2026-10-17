// Backup job staleness: jobs whose lastRunAt has fallen behind their schedule.

import { Cron } from "croner";

import { appNotRunning, type AppRunState } from "@/lib/apps/run-state";

/** Missed runs before a job counts as overdue. One late run is a slow night. */
export const OVERDUE_INTERVALS = 2;

/** Fires sampled to measure an interval. Weekday-only schedules vary by gap. */
const INTERVAL_SAMPLES = 4;

/** An app a job backs up. `startedAt` is the operator's last start of it. */
export type JobApp = AppRunState & { id: string; startedAt?: Date | null };

export type ScheduledBackupJob = {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastRunAt: Date | null;
  createdAt: Date;
  /** Apps the job covers, linked or through a volume. Unknown when omitted. */
  apps?: JobApp[];
  /** Covers a volume no app owns. */
  looseVolumes?: boolean;
};

export type OverdueBackupJob = {
  job: ScheduledBackupJob;
  /** Last capture, or when the job was created if it has never captured one, or a later start of one of its apps. */
  since: Date;
  neverRan: boolean;
  /** Apps in the job stopped on purpose. */
  stoppedAppIds: string[];
};

/** A job past due only because every app it covers was stopped on purpose. */
export type StoppedBackupJob = {
  job: ScheduledBackupJob;
  lastBackupAt: Date | null;
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

/** Latest operator start among apps now running. */
function resumedAt(apps: JobApp[]): number {
  return Math.max(0, ...apps.flatMap((a) => (a.startedAt && !appNotRunning(a) ? [a.startedAt.getTime()] : [])));
}

/** Enabled jobs past OVERDUE_INTERVALS of their schedule, split by whether their apps were stopped on purpose. */
export function backupJobStaleness(
  jobs: ScheduledBackupJob[],
  now: Date,
): { overdue: OverdueBackupJob[]; stopped: StoppedBackupJob[] } {
  const overdue: OverdueBackupJob[] = [];
  const stopped: StoppedBackupJob[] = [];

  for (const job of jobs) {
    if (!job.enabled) continue;
    const interval = scheduleIntervalMs(job.schedule, now);
    if (interval === null) continue;

    const apps = job.apps ?? [];
    // A start resets the clock, so the first run after it gets its full window.
    const since = new Date(Math.max((job.lastRunAt ?? job.createdAt).getTime(), resumedAt(apps)));
    if (now.getTime() - since.getTime() <= interval * OVERDUE_INTERVALS) continue;

    const stoppedAppIds = apps.filter((a) => appNotRunning(a)).map((a) => a.id);
    if (apps.length > 0 && stoppedAppIds.length === apps.length && !job.looseVolumes) {
      stopped.push({ job, lastBackupAt: job.lastRunAt });
      continue;
    }
    overdue.push({ job, since, neverRan: job.lastRunAt === null, stoppedAppIds });
  }

  return { overdue, stopped };
}

/** Enabled jobs that have captured nothing for OVERDUE_INTERVALS of their schedule, leaving out jobs whose apps were all stopped on purpose. */
export function overdueBackupJobs(jobs: ScheduledBackupJob[], now: Date): OverdueBackupJob[] {
  return backupJobStaleness(jobs, now).overdue;
}
