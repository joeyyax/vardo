import { db } from "@/lib/db";
import { backupJobs, backups } from "@/lib/db/schema";
import { eq, and, gt, inArray } from "drizzle-orm";
import { runBackup, STALE_RUN_MS } from "./engine";
import { shouldRunNow } from "@/lib/cron/parse";
import { acquireLock } from "@/lib/redis-lock";
import { logger } from "@/lib/logger";
import { selectDrillCandidates, type DrillCandidate } from "./drill-schedule";

const log = logger.child("backup");

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

      // Acquire a distributed lock for this job+minute to prevent double-fire
      const minuteTs = Math.floor(now.getTime() / 60_000);
      const locked = await acquireLock(`lock:backup:${job.id}:${minuteTs}`, 61_000);
      if (!locked) continue;

      // Skip a run that is genuinely in flight. Time-bounded like the manual
      // path: a row left "running" by a crashed process would otherwise block
      // this job forever. lastRunAt is left to runBackup, which only refreshes
      // it for a run that actually captured something.
      const runningBackup = await db.query.backups.findFirst({
        where: and(
          eq(backups.jobId, job.id),
          inArray(backups.status, ["pending", "running"]),
          gt(backups.startedAt, new Date(now.getTime() - STALE_RUN_MS)),
        ),
      });

      if (runningBackup) {
        log.info(
          `Skipping job "${job.name}" — already running (backup ${runningBackup.id})`,
        );
        continue;
      }

      log.info(`Running job "${job.name}" (${job.id})`);

      const results = await runBackup(job.id);

      const succeeded = results.filter((r) => r.outcome === "success").length;
      const failed = results.filter((r) => r.outcome === "failed").length;
      const skipped = results.filter((r) => r.outcome === "skipped").length;

      log.info(
        `Job "${job.name}" finished: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`,
      );
    } catch (err) {
      log.error(`Job "${job.name}" (${job.id}) error:`, err);
      // Continue to next job — don't let one failure crash the whole tick
    }
  }
}

// ---------------------------------------------------------------------------
// Drill tick
// ---------------------------------------------------------------------------

/** How many drills one tick may start. Each costs a container and a download. */
const DRILLS_PER_TICK = 1;

/**
 * Drill whichever archive's restorability is least known.
 *
 * Separate from the backup tick so a slow drill can never delay a backup, and
 * so turning drills off leaves backups untouched.
 */
export async function tickRestoreDrills(now = new Date()): Promise<void> {
  const locked = await acquireLock(`lock:drill:${Math.floor(now.getTime() / 60_000)}`, 61_000);
  if (!locked) return;

  const rows = await db.query.backups.findMany({
    where: eq(backups.status, "success"),
    columns: {
      id: true,
      appId: true,
      volumeName: true,
      finishedAt: true,
      verifiedAt: true,
      verifyOutcome: true,
    },
  });

  const candidates: DrillCandidate[] = rows
    .filter((r): r is typeof r & { finishedAt: Date } => r.finishedAt !== null)
    .map((r) => ({
      backupId: r.id,
      volumeKey: `${r.appId ?? "system"}:${r.volumeName ?? ""}`,
      finishedAt: r.finishedAt,
      verifiedAt: r.verifiedAt,
      verifyOutcome: r.verifyOutcome,
    }));

  const due = selectDrillCandidates(candidates, now, DRILLS_PER_TICK);
  if (due.length === 0) return;

  const { runRestoreDrill } = await import("./drill");
  for (const candidate of due) {
    try {
      const result = await runRestoreDrill(candidate.backupId);
      log.info(`Drill ${candidate.volumeKey}: ${result.outcome} — ${result.detail}`);
    } catch (err) {
      log.error(`Drill ${candidate.volumeKey} error:`, err);
    }
  }
}
