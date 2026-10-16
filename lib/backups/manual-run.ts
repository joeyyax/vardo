// Backups and drills started by hand: one run per job at a time across consoles, each in a backup slot.

import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { MANUAL_TRIGGER, runBackup, STALE_RUN_MS, type BackupResult } from "./engine";
import type { DrillResult } from "./drill";
import { withSizedBackupSlot } from "./run-limit";

export type ManualStart =
  | { started: true; done: Promise<BackupResult[]> }
  /** `startedAt` is the running backup's, null when another request is starting one. */
  | { started: false; startedAt: Date | null };

const lockKey = (jobId: string) => `lock:backup:manual:${jobId}`;

/** Starts a job by hand unless it's already running. `force` skips the check. Waits for a free slot. */
export async function startManualBackup(
  jobId: string,
  opts: { appIds?: string[]; force?: boolean } = {},
): Promise<ManualStart> {
  const run = () =>
    withSizedBackupSlot(() => runBackup(jobId, { ...(opts.appIds ? { appIds: opts.appIds } : {}), trigger: MANUAL_TRIGGER }));
  if (opts.force) return { started: true, done: run() };

  const token = await acquireLock(lockKey(jobId), STALE_RUN_MS);
  if (!token) return { started: false, startedAt: null };
  const release = () => releaseLock(lockKey(jobId), token).catch(() => false);

  try {
    const inFlight = await db.query.backups.findFirst({
      where: and(
        eq(backups.jobId, jobId),
        inArray(backups.status, ["pending", "running"]),
        gt(backups.startedAt, new Date(Date.now() - STALE_RUN_MS)),
      ),
      columns: { startedAt: true },
    });
    if (inFlight) {
      await release();
      return { started: false, startedAt: inFlight.startedAt };
    }
  } catch (err) {
    await release();
    throw err;
  }

  const done = run().finally(release);
  return { started: true, done };
}

/** A restore drill started by hand. Waits for a free slot. */
export function runManualDrill(backupId: string): Promise<DrillResult> {
  return withSizedBackupSlot(async () => (await import("./drill")).runRestoreDrill(backupId));
}
