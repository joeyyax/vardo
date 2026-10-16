import { db } from "@/lib/db";
import { backupJobs, backups } from "@/lib/db/schema";
import { eq, and, gt, inArray } from "drizzle-orm";
import { runBackup, STALE_RUN_MS } from "./engine";
import { shouldRunNow } from "@/lib/cron/parse";
import { acquireLock } from "@/lib/redis-lock";
import { logger } from "@/lib/logger";
import { needsSetup } from "@/lib/setup";
import { selectDrillCandidates, type DrillCandidate } from "./drill-schedule";
import { backupSlotLimit, withBackupSlot } from "./run-limit";
import { holdRunJobLease } from "./run-lease";
import { backupsDraining } from "./in-flight";
import { claimJob, claimJobWhenFree, jobClaimHolder, type ReleaseClaim } from "./job-claim";
import { NIGHTLY_REUSE_WINDOW_MS } from "./run-rules";

const log = logger.child("backup");

/** Jobs waiting for or holding a slot, so an every-minute schedule can't stack runs behind a slow one. */
const queued = new Set<string>();

/** Run any enabled backup jobs that are due, at most the backup concurrency at once. Call every minute. */
export async function tickBackupJobs(now = new Date(), opts: { claimPollMs?: number } = {}): Promise<void> {
  // A fresh instance's empty database would land in the bucket beside the backups a restore lists.
  if (await needsSetup()) return;
  // This console is about to stop; the one replacing it takes the schedule.
  if (backupsDraining()) return;

  const jobs = await db.query.backupJobs.findMany({
    where: eq(backupJobs.enabled, true),
  });

  const limit = await backupSlotLimit();
  const runs: Promise<void>[] = [];
  const { adoptManualRun, markJobDone, startJobRun, startNightlyRuns } = await import("./runs");
  const nightlyRun = await startNightlyRuns(now).catch((err) => {
    log.error("Nightly run start error:", err);
    return new Map<string, string>();
  });
  // Held until each job reports, so a sweep can tell this process's jobs from a dead one's.
  const leases = new Map<string, Promise<() => Promise<void>>>();
  const hold = (runId: string, jobId: string) => {
    if (!leases.has(jobId)) leases.set(jobId, holdRunJobLease(runId, jobId));
  };
  const release = async (jobId: string) => {
    const lease = leases.get(jobId);
    leases.delete(jobId);
    await (await lease)?.();
  };
  for (const [jobId, runId] of nightlyRun) hold(runId, jobId);
  const reporting = new Set<string>();

  // A nightly job that won't run now still counts as done, or its run waits out the deadline.
  const skipInRun = (jobId: string) => {
    const runId = nightlyRun.get(jobId);
    if (!runId) return;
    reporting.add(jobId);
    markJobDone(runId, jobId).catch(() => {}).finally(() => release(jobId));
  };

  // Waits out a run started by hand, then takes a manual backup from the window as the job's result or runs it.
  const runNightly = async (job: { id: string; name: string }, runId: string, claim: ReleaseClaim | null) => {
    claim ??= await claimJobWhenFree(job.id, "scheduled", opts.claimPollMs);
    try {
      if (await adoptManualRun(runId, job.id, new Date(now.getTime() - NIGHTLY_REUSE_WINDOW_MS))) {
        log.info(`Job "${job.name}" uses its manual backup as tonight's result`);
        return;
      }
      await withBackupSlot(limit, () => runJob(job, runId));
      await markJobDone(runId, job.id);
    } finally {
      await claim();
    }
  };

  for (const job of jobs) {
    let claim: ReleaseClaim | null = null;
    try {
      if (job.nightly ? !nightlyRun.has(job.id) : !shouldRunNow(job.schedule, now)) continue;
      if (queued.has(job.id)) {
        log.info(`Skipping job "${job.name}" — still waiting on its last run`);
        skipInRun(job.id);
        continue;
      }

      // Per job+minute lock against double-fire.
      const minuteTs = Math.floor(now.getTime() / 60_000);
      const locked = await acquireLock(`lock:backup:${job.id}:${minuteTs}`, 61_000);
      if (!locked) continue;

      const nightlyRunId = nightlyRun.get(job.id);
      claim = await claimJob(job.id, "scheduled", now);
      // A nightly job waits for a run started by hand, even one still waiting for a slot.
      if (!claim && !(nightlyRunId && (await jobClaimHolder(job.id))?.by !== "scheduled")) {
        log.info(`Skipping job "${job.name}" — already running`);
        skipInRun(job.id);
        continue;
      }

      // Skip a run in flight. Time-bounded so a crashed run can't block the job forever.
      const runningBackup = claim
        ? await db.query.backups.findFirst({
            where: and(
              eq(backups.jobId, job.id),
              inArray(backups.status, ["pending", "running"]),
              gt(backups.startedAt, new Date(now.getTime() - STALE_RUN_MS)),
            ),
          })
        : undefined;

      if (runningBackup) {
        log.info(
          `Skipping job "${job.name}" — already running (backup ${runningBackup.id})`,
        );
        await claim?.();
        claim = null;
        skipInRun(job.id);
        continue;
      }

      reporting.add(job.id);
      queued.add(job.id);
      const held = claim;
      claim = null;
      if (nightlyRunId) {
        runs.push(
          runNightly(job, nightlyRunId, held)
            .finally(() => queued.delete(job.id))
            .catch((err) => log.error(`Job "${job.name}" didn't report to its run:`, err))
            .finally(() => release(job.id)),
        );
        continue;
      }
      const runId = await startJobRun(job, now).catch(() => null);
      if (runId) hold(runId, job.id);
      runs.push(
        withBackupSlot(limit, () => runJob(job, runId))
          .finally(() => queued.delete(job.id))
          .then(() => (runId ? markJobDone(runId, job.id) : undefined))
          .catch((err) => log.error(`Job "${job.name}" didn't report to its run:`, err))
          .finally(() => Promise.all([release(job.id), held?.()])),
      );
    } catch (err) {
      log.error(`Job "${job.name}" (${job.id}) error:`, err);
      await claim?.();
      skipInRun(job.id);
    }
  }
  // Jobs this tick left alone are free for a sweep to requeue.
  for (const jobId of [...leases.keys()]) if (!reporting.has(jobId)) void release(jobId);

  try {
    const { startDueInitialBackups } = await import("./initial-backup");
    runs.push(...(await startDueInitialBackups({ now, limit, queued })));
  } catch (err) {
    log.error("First snapshot tick error:", err);
  }

  await Promise.all(runs);
}

/** Takes a manual backup from the window before a nightly run's time as the job's result there. False for another kind of run or none to take. */
async function adoptIntoNightly(runId: string | null, jobId: string): Promise<boolean> {
  if (!runId) return false;
  const { adoptManualRun, nightlyRunStart } = await import("./runs");
  const due = await nightlyRunStart(runId);
  return due !== null && adoptManualRun(runId, jobId, new Date(due.getTime() - NIGHTLY_REUSE_WINDOW_MS));
}

/**
 * Runs an interrupted job again under the slot cap once no other run holds it, then reports it to its run.
 * A nightly run takes a manual backup from its window instead. False when the job is already queued.
 */
export function runRequeuedJob(
  job: { id: string; name: string },
  opts: { runId: string | null; trigger: string },
): Promise<void> | false {
  if (queued.has(job.id)) return false;
  queued.add(job.id);
  const lease = opts.runId ? holdRunJobLease(opts.runId, job.id) : null;
  const claim = claimJobWhenFree(job.id, "scheduled");
  return Promise.all([backupSlotLimit(), claim])
    .then(async ([limit]) => {
      if (await adoptIntoNightly(opts.runId, job.id)) {
        log.info(`Requeued job "${job.name}" uses its manual backup as the nightly result`);
        return true;
      }
      await withBackupSlot(limit, () => runJob(job, opts.runId, opts.trigger));
      return false;
    })
    .finally(() => queued.delete(job.id))
    .then(async (adopted) => {
      if (!opts.runId || adopted) return;
      const { markJobDone } = await import("./runs");
      await markJobDone(opts.runId, job.id);
    })
    .catch((err) => log.error(`Requeued job "${job.name}" didn't report to its run:`, err))
    .finally(async () => {
      await (await claim.catch(() => null))?.();
      await (await lease)?.();
    });
}

async function runJob(job: { id: string; name: string }, runId: string | null, trigger?: string): Promise<void> {
  try {
    log.info(`Running job "${job.name}" (${job.id})`);

    const results = await runBackup(job.id, trigger ? { runId, trigger } : { runId });

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

/** How many drills one tick may start. */
const DRILLS_PER_TICK = 1;

/** Drill whichever archive's restorability is least known. */
export async function tickRestoreDrills(now = new Date()): Promise<void> {
  if (backupsDraining()) return;
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
  const limit = await backupSlotLimit();
  for (const candidate of due) {
    try {
      const result = await withBackupSlot(limit, () => runRestoreDrill(candidate.backupId));
      log.info(`Drill ${candidate.volumeKey}: ${result.outcome} — ${result.detail}`);
    } catch (err) {
      log.error(`Drill ${candidate.volumeKey} error:`, err);
    }
  }
}
