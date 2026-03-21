import { db } from "@/lib/db";
import { backupJobs, backups } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { runBackup } from "./engine";
import { shouldRunNow, isSameMinute } from "@/lib/cron/parse";

// ---------------------------------------------------------------------------
// Public tick
// ---------------------------------------------------------------------------

/**
 * Check all enabled backup jobs and run any that are due.
 * Call this every minute from the backup scheduler.
 */
export async function tickBackupJobs(): Promise<void> {
  const now = new Date();

  const jobs = await db.query.backupJobs.findMany({
    where: eq(backupJobs.enabled, true),
  });

  for (const job of jobs) {
    try {
      // Check if this job should run now based on its cron schedule
      if (!shouldRunNow(job.schedule, now)) continue;

      // Avoid running the same job twice in the same minute
      if (job.lastRunAt && isSameMinute(new Date(job.lastRunAt), now)) {
        continue;
      }

      // Check if this job already has a backup in "running" state (still in progress)
      const runningBackup = await db.query.backups.findFirst({
        where: and(eq(backups.jobId, job.id), eq(backups.status, "running")),
      });

      if (runningBackup) {
        console.log(
          `[backup] Skipping job "${job.name}" — already running (backup ${runningBackup.id})`,
        );
        continue;
      }

      // Mark lastRunAt before executing so a concurrent tick won't double-fire
      await db
        .update(backupJobs)
        .set({ lastRunAt: now, updatedAt: now })
        .where(eq(backupJobs.id, job.id));

      console.log(`[backup] Running job "${job.name}" (${job.id})`);

      const results = await runBackup(job.id);

      const succeeded = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;

      console.log(
        `[backup] Job "${job.name}" finished: ${succeeded} succeeded, ${failed} failed`,
      );
    } catch (err) {
      console.error(`[backup] Job "${job.name}" (${job.id}) error:`, err);
      // Continue to next job — don't let one failure crash the whole tick
    }
  }
}
