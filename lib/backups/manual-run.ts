// Backups and drills started by hand: one run per job at a time across consoles, each in a backup slot.

import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs, backups } from "@/lib/db/schema";
import { MANUAL_TRIGGER, runBackup, STALE_RUN_MS, type BackupResult } from "./engine";
import type { DrillResult } from "./drill";
import { claimJob, jobClaimHolder } from "./job-claim";
import { NIGHTLY_REUSE_WINDOW_MS } from "./run-rules";
import { withSizedBackupSlot } from "./run-limit";

export type ManualStart =
  | { started: true; done: Promise<BackupResult[]> }
  /** The run in progress it uses instead. `startedAt` is that run's, null when another request is starting one. */
  | { started: false; startedAt: Date | null };

/**
 * Starts a job by hand unless a run of it is in progress or its nightly run started in the last few minutes,
 * which it uses instead. `force` skips the backup row and nightly checks, never a run that holds the job. Waits for a free slot.
 */
export async function startManualBackup(
  jobId: string,
  opts: { appIds?: string[]; force?: boolean } = {},
): Promise<ManualStart> {
  const startedAt = new Date();
  const release = await claimJob(jobId, "manual", startedAt);
  if (!release) return { started: false, startedAt: (await jobClaimHolder(jobId))?.startedAt ?? null };
  if (!opts.force) {
    try {
      const inProgress = await runInProgress(jobId, startedAt);
      if (inProgress) {
        await release();
        return { started: false, startedAt: inProgress };
      }
    } catch (err) {
      await release();
      throw err;
    }
  }

  const done = runManual(jobId, startedAt, opts.appIds).finally(release);
  return { started: true, done };
}

/** When a run this one should use started: a backup of the job still running, or a nightly run that just started. */
async function runInProgress(jobId: string, now: Date): Promise<Date | null> {
  const inFlight = await db.query.backups.findFirst({
    where: and(
      eq(backups.jobId, jobId),
      inArray(backups.status, ["pending", "running"]),
      gt(backups.startedAt, new Date(now.getTime() - STALE_RUN_MS)),
    ),
    columns: { startedAt: true },
  });
  if (inFlight) return inFlight.startedAt;
  const { nightlyRunStartedSince } = await import("./runs");
  return nightlyRunStartedSince(jobId, new Date(now.getTime() - NIGHTLY_REUSE_WINDOW_MS));
}

/** Opens the run before waiting for a slot, so a nightly run due meanwhile finds it. */
async function runManual(jobId: string, now: Date, appIds?: string[]): Promise<BackupResult[]> {
  const { markJobDone, startManualRun } = await import("./runs");
  const job = await db.query.backupJobs.findFirst({
    where: eq(backupJobs.id, jobId),
    columns: { id: true, name: true, organizationId: true },
  });
  const runId = job ? await startManualRun(job, now, appIds).catch(() => null) : null;
  try {
    return await withSizedBackupSlot(() =>
      runBackup(jobId, { ...(appIds ? { appIds } : {}), trigger: MANUAL_TRIGGER, ...(runId ? { runId } : {}) }),
    );
  } finally {
    if (runId) await markJobDone(runId, jobId).catch(() => {});
  }
}

/** A restore drill started by hand. Waits for a free slot. */
export function runManualDrill(backupId: string): Promise<DrillResult> {
  return withSizedBackupSlot(async () => (await import("./drill")).runRestoreDrill(backupId));
}
