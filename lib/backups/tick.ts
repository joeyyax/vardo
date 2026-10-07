import { db } from "@/lib/db";
import { backupJobs, backups } from "@/lib/db/schema";
import { eq, and, gt, inArray } from "drizzle-orm";
import { runBackup, STALE_RUN_MS } from "./engine";
import { shouldRunNow } from "@/lib/cron/parse";
import { acquireLock } from "@/lib/redis-lock";
import { logger } from "@/lib/logger";
import { selectDrillCandidates, type DrillCandidate } from "./drill-schedule";

const log = logger.child("backup");

/** Run any enabled backup jobs that are due. Call every minute. */
export async function tickBackupJobs(): Promise<void> {
  const now = new Date();

  const jobs = await db.query.backupJobs.findMany({
    where: eq(backupJobs.enabled, true),
  });

  for (const job of jobs) {
    try {
      if (!shouldRunNow(job.schedule, now)) continue;

      // Per job+minute lock against double-fire.
      const minuteTs = Math.floor(now.getTime() / 60_000);
      const locked = await acquireLock(`lock:backup:${job.id}:${minuteTs}`, 61_000);
      if (!locked) continue;

      // Skip a run in flight. Time-bounded so a crashed run can't block the job forever.
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
    }
  }
}

/** How many drills one tick may start. */
const DRILLS_PER_TICK = 1;

/** Drill whichever archive's restorability is least known. */
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
