// Reruns scheduled backups a stopped console cut off, once each, and keeps their run's summary waiting for them.

import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, like, notIlike, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs, backupRuns, backups } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { REQUEUE_TRIGGER } from "./engine";
import { backupsDraining } from "./in-flight";
import { INTERRUPTED_REASON } from "./reap";
import { runDeadline } from "./run-rules";

const log = logger.child("backup");

/** Interrupted rows older than this stay failed. */
export function requeueWindowMs(env: Record<string, string | undefined> = process.env): number {
  const hours = Number(env.VARDO_BACKUP_REQUEUE_HOURS);
  return (Number.isFinite(hours) && hours >= 0 ? hours : 12) * 60 * 60_000;
}

// A first snapshot covers one app, not the job.
const FIRST_SNAPSHOT_TRIGGERS = ["initial", "import"];

export const REQUEUED_NOTE = "Requeued once after the interruption";
export const NOT_REQUEUED_NOTE = "Not requeued after the interruption";

export type InterruptedRow = { id: string; jobId: string; startedAt: Date };

export type Requeue = { jobId: string; rowIds: string[]; latestStartedAt: Date };

/** One rerun per job. The whole job reruns: apps it hadn't reached yet left no row. */
export function planRequeues(rows: InterruptedRow[]): Requeue[] {
  const byJob = new Map<string, InterruptedRow[]>();
  for (const row of rows) byJob.set(row.jobId, [...(byJob.get(row.jobId) ?? []), row]);
  return [...byJob].map(([jobId, list]) => ({
    jobId,
    rowIds: list.map((r) => r.id),
    latestStartedAt: new Date(Math.max(...list.map((r) => r.startedAt.getTime()))),
  }));
}

/** Appends `line` to rows nobody has noted yet. Returns the rows this call claimed. */
async function claimRows(ids: string[], line: string): Promise<string[]> {
  const claimed = await db
    .update(backups)
    .set({ log: sql`coalesce(${backups.log}, '') || ${`\n${line}`}` })
    .where(and(inArray(backups.id, ids), eq(backups.status, "failed"), notIlike(backups.log, "%requeued%")))
    .returning({ id: backups.id });
  return claimed.map((r) => r.id);
}

/** The open run waiting on this job, with its deadline pushed out to cover the rerun. */
async function runAwaiting(organizationId: string | null, jobId: string, now: Date, windowMs: number): Promise<string | null> {
  if (!organizationId) return null;
  const open = await db.query.backupRuns.findMany({
    where: and(
      eq(backupRuns.organizationId, organizationId),
      isNull(backupRuns.finishedAt),
      gte(backupRuns.startedAt, new Date(now.getTime() - windowMs)),
    ),
    orderBy: [desc(backupRuns.startedAt)],
  });
  const run = open.find((r) => r.plan.jobs.some((j) => j.jobId === jobId) && !r.jobsDone.includes(jobId));
  if (!run) return null;
  const deadline = runDeadline(now.getTime(), run.estimatedMs);
  if (deadline > run.deadlineAt.getTime()) {
    await db
      .update(backupRuns)
      .set({ deadlineAt: new Date(deadline) })
      .where(and(eq(backupRuns.id, run.id), isNull(backupRuns.finishedAt)));
  }
  return run.id;
}

type RunJob = (
  job: { id: string; name: string },
  opts: { runId: string | null; trigger: string },
) => Promise<void> | false;

/**
 * Reruns each scheduled job with rows a stopped console cut off in the window, once. Restores, drills, imports,
 * first snapshots and hand-started runs are never repeated. Returns the job IDs started.
 */
export async function requeueInterruptedBackups(
  now = new Date(),
  deps: { runJob?: RunJob; windowMs?: number } = {},
): Promise<string[]> {
  const windowMs = deps.windowMs ?? requeueWindowMs();
  const runJob = deps.runJob ?? (await import("./tick")).runRequeuedJob;

  const rows = await db
    .select({ id: backups.id, jobId: backups.jobId, startedAt: backups.startedAt })
    .from(backups)
    .where(
      and(
        eq(backups.status, "failed"),
        isNotNull(backups.jobId),
        isNull(backups.trigger),
        gt(backups.startedAt, new Date(now.getTime() - windowMs)),
        like(backups.log, `%${INTERRUPTED_REASON}%`),
        notIlike(backups.log, "%requeued%"),
      ),
    );

  const started: string[] = [];
  const stamp = `[${now.toISOString()}]`;
  for (const plan of planRequeues(rows as InterruptedRow[])) {
    try {
      const job = await db.query.backupJobs.findFirst({
        where: eq(backupJobs.id, plan.jobId),
        columns: { id: true, name: true, enabled: true, organizationId: true },
      });

      const later = await db.query.backups.findFirst({
        where: and(
          eq(backups.jobId, plan.jobId),
          gt(backups.startedAt, plan.latestStartedAt),
          notInArray(backups.id, plan.rowIds),
          or(isNull(backups.trigger), notInArray(backups.trigger, FIRST_SNAPSHOT_TRIGGERS)),
        ),
        columns: { id: true },
      });

      const skip = !job?.enabled ? "the job is off or gone" : later ? "a later run of the job already started" : null;
      const claimed = await claimRows(plan.rowIds, `${stamp} ${skip ? `${NOT_REQUEUED_NOTE}: ${skip}` : REQUEUED_NOTE}`);
      if (claimed.length === 0 || !job) continue;

      const runId = await runAwaiting(job.organizationId, job.id, now, windowMs);
      if (skip) {
        if (runId) {
          const { markJobDone } = await import("./runs");
          await markJobDone(runId, job.id);
        }
        log.info(`Not requeuing job "${job.name}": ${skip}`);
        continue;
      }

      log.info(`Requeuing job "${job.name}" after the console running it stopped`);
      runJob({ id: job.id, name: job.name }, { runId, trigger: REQUEUE_TRIGGER });
      started.push(job.id);
    } catch (err) {
      log.error(`Couldn't requeue job ${plan.jobId}:`, err);
    }
  }
  return started;
}

/** Reaps rows whose process died, then requeues them. Safe beside a live scheduler and across consoles. */
export async function sweepInterruptedBackups(now = new Date()): Promise<void> {
  // A console about to stop leaves the rerun to the one replacing it.
  if (backupsDraining()) return;
  const { reapInterruptedBackups } = await import("./reap");
  // A row's lease is taken just after its insert.
  await reapInterruptedBackups(now, { minAgeMs: 60_000 });
  await requeueInterruptedBackups(now);
}
