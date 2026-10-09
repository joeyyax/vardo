// An app's first snapshot: taken once it has run cleanly for a while, retried with backoff until one lands.

import { db } from "@/lib/db";
import {
  apps,
  backupJobApps,
  backups,
  containerSelfHeal,
  deployments,
  initialBackups,
} from "@/lib/db/schema";
import { and, eq, gt, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { acquireLock } from "@/lib/redis-lock";
import { isBulkWriteRunning } from "@/lib/metrics/bulk-write";
import { logger } from "@/lib/logger";
import { runBackup, runSucceeded, STALE_RUN_MS } from "./engine";
import { resolveAppBackupSwitch } from "./switch";
import { withBackupSlot } from "./run-limit";

const log = logger.child("initial-backup");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const HEALTHY_WINDOW_MS = 15 * MINUTE;
export const IMPORT_DELAY_MS = 5 * MINUTE;
export const GIVE_UP_AFTER_MS = 24 * HOUR;
/** A backup row this recent means the app needs no first snapshot. */
export const RECENT_RUN_MS = 6 * HOUR;
const MAX_RETRY_MS = 4 * HOUR;
const BUSY_RETRY_MS = 5 * MINUTE;

export type InitialReason = "deploy" | "import";

/** Wait after the nth failed attempt: 15m, 30m, 1h, 2h, then 4h. */
export function retryDelayMs(attempts: number): number {
  return Math.min(HEALTHY_WINDOW_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

export type InitialFacts = {
  now: Date;
  expiresAt: Date;
  appStatus: string;
  switchedOn: boolean;
  job: { id: string; enabled: boolean } | null;
  /** A successful backup that already covers what this snapshot would. */
  alreadyCovered: boolean;
  /** A failed deploy, rollback or container restart since the window opened. */
  troubleSinceArmed: boolean;
  importRunning: boolean;
  backupInFlight: boolean;
};

export type InitialStep =
  | { kind: "finish"; outcome: "covered" | "skipped" | "expired" }
  | { kind: "wait"; dueAt: Date; restartWindow: boolean }
  | { kind: "run"; jobId: string };

/** What a due row does next. */
export function decideInitialStep(f: InitialFacts): InitialStep {
  const at = (ms: number) => new Date(f.now.getTime() + ms);
  if (f.now >= f.expiresAt) return { kind: "finish", outcome: "expired" };
  if (!f.switchedOn || !f.job?.enabled) return { kind: "finish", outcome: "skipped" };
  if (f.alreadyCovered) return { kind: "finish", outcome: "covered" };
  if (f.appStatus !== "active" || f.troubleSinceArmed) {
    return { kind: "wait", dueAt: at(HEALTHY_WINDOW_MS), restartWindow: true };
  }
  if (f.importRunning || f.backupInFlight) return { kind: "wait", dueAt: at(BUSY_RETRY_MS), restartWindow: false };
  return { kind: "run", jobId: f.job.id };
}

/** The app's backup job in its own org or the instance's, enabled first. */
async function coveringJob(app: { id: string; organizationId: string }) {
  const links = await db.query.backupJobApps.findMany({
    where: eq(backupJobApps.appId, app.id),
    with: { backupJob: { columns: { id: true, organizationId: true, enabled: true } } },
  });
  const jobs = links
    .map((l) => l.backupJob)
    .filter((j) => j.organizationId === app.organizationId || j.organizationId === null);
  return jobs.find((j) => j.enabled) ?? jobs[0] ?? null;
}

/**
 * Schedule an app's first snapshot. A deploy arms it once per app, and only for an app with no
 * successful backup and nothing run recently; a redeploy while pending restarts the healthy window.
 * An import always re-arms, 5 minutes out.
 */
export async function armInitialBackup(appId: string, reason: InitialReason, now = new Date()): Promise<boolean> {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
    columns: { id: true, organizationId: true },
  });
  if (!app) return false;

  const existing = await db.query.initialBackups.findFirst({ where: eq(initialBackups.appId, appId) });
  const delay = reason === "import" ? IMPORT_DELAY_MS : HEALTHY_WINDOW_MS;
  const dueAt = new Date(now.getTime() + delay);

  if (reason === "deploy" && existing) {
    if (existing.finishedAt) return false;
    await db.update(initialBackups).set({ armedAt: now, dueAt }).where(eq(initialBackups.appId, appId));
    return true;
  }

  if (!(await coveringJob(app))) return false;

  if (reason === "deploy") {
    const prior = await db.query.backups.findFirst({
      where: and(
        eq(backups.appId, appId),
        or(eq(backups.status, "success"), gt(backups.startedAt, new Date(now.getTime() - RECENT_RUN_MS))),
      ),
      columns: { id: true },
    });
    if (prior) return false;
  }

  const row = {
    reason,
    armedAt: now,
    dueAt,
    expiresAt: new Date(now.getTime() + GIVE_UP_AFTER_MS),
    attempts: 0,
    lastError: null,
    outcome: null,
    finishedAt: null,
  };
  await db
    .insert(initialBackups)
    .values({ appId, ...row })
    .onConflictDoUpdate({ target: initialBackups.appId, set: row });
  log.info(`First snapshot of ${appId} due ${dueAt.toISOString()} (${reason})`);
  return true;
}

/** armInitialBackup for hooks: a failure is logged, never thrown. */
export function armInitialBackupQuietly(appId: string, reason: InitialReason): void {
  armInitialBackup(appId, reason).catch((err) => {
    log.warn(`Arming first snapshot of ${appId} failed: ${err instanceof Error ? err.message : err}`);
  });
}

type PendingRow = typeof initialBackups.$inferSelect;

async function gatherFacts(row: PendingRow, now: Date): Promise<InitialFacts | null> {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, row.appId),
    columns: { id: true, organizationId: true, status: true },
  });
  if (!app) return null;

  const job = await coveringJob(app);
  const switchedOn = (await resolveAppBackupSwitch(app.id))?.enabled !== false;

  // An import's snapshot needs a backup taken after it.
  const success = await db.query.backups.findFirst({
    where: and(
      eq(backups.appId, app.id),
      eq(backups.status, "success"),
      ...(row.reason === "import" ? [gte(backups.startedAt, row.armedAt)] : []),
    ),
    columns: { id: true },
  });

  const failedDeploy = await db.query.deployments.findFirst({
    where: and(
      eq(deployments.appId, app.id),
      inArray(deployments.status, ["failed", "rolled_back"]),
      gte(deployments.finishedAt, row.armedAt),
    ),
    columns: { id: true },
  });
  const heals = await db.query.containerSelfHeal.findMany({
    where: and(eq(containerSelfHeal.appId, app.id), gte(containerSelfHeal.updatedAt, row.armedAt)),
    columns: { restarts: true, gaveUpAt: true },
  });
  const crashed = heals.some((h) => h.gaveUpAt || h.restarts.some((t) => t >= row.armedAt.getTime()));

  const inFlight = job
    ? await db.query.backups.findFirst({
        where: and(
          eq(backups.jobId, job.id),
          inArray(backups.status, ["pending", "running"]),
          gt(backups.startedAt, new Date(now.getTime() - STALE_RUN_MS)),
        ),
        columns: { id: true },
      })
    : undefined;

  return {
    now,
    expiresAt: row.expiresAt,
    appStatus: app.status,
    switchedOn,
    job,
    alreadyCovered: !!success,
    troubleSinceArmed: !!failedDeploy || crashed,
    importRunning: await isBulkWriteRunning(app.id),
    backupInFlight: !!inFlight,
  };
}

async function finish(appId: string, outcome: string, at: Date, extra: Partial<PendingRow> = {}) {
  await db
    .update(initialBackups)
    .set({ ...extra, outcome, finishedAt: at })
    .where(eq(initialBackups.appId, appId));
}

/** One attempt. Failure is retried with backoff until the row expires. */
async function attempt(row: PendingRow, jobId: string): Promise<void> {
  const attempts = row.attempts + 1;
  const retryAt = (from: Date) => new Date(from.getTime() + retryDelayMs(attempts));
  const lastChance = retryAt(new Date()) >= row.expiresAt;
  let error: string | null = null;
  let outcome: "success" | "skipped" | null = null;
  try {
    const results = await runBackup(jobId, {
      appIds: [row.appId],
      trigger: row.reason === "import" ? "import" : "initial",
      notifyFailure: lastChance,
    });
    if (results.length === 0) outcome = "skipped";
    else if (runSucceeded(results)) outcome = "success";
    else error = results.find((r) => r.outcome !== "success")?.error ?? "Nothing was captured";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const done = new Date();
  if (outcome) {
    await finish(row.appId, outcome, done, { attempts });
    log.info(`First snapshot of ${row.appId}: ${outcome}`);
    return;
  }
  if (lastChance) {
    await finish(row.appId, "expired", done, { attempts, lastError: error });
    log.warn(`First snapshot of ${row.appId} gave up after ${attempts} attempt(s): ${error}`);
    return;
  }
  await db
    .update(initialBackups)
    .set({ attempts, lastError: error, dueAt: retryAt(done) })
    .where(eq(initialBackups.appId, row.appId));
  log.warn(`First snapshot of ${row.appId} failed (attempt ${attempts}), retrying: ${error}`);
}

/** Start the first snapshots now due. Shares the scheduler's slots and its per-job queue. */
export async function startDueInitialBackups(opts: {
  now: Date;
  limit: number;
  queued: Set<string>;
}): Promise<Promise<void>[]> {
  const { now, limit, queued } = opts;
  const due = await db.query.initialBackups.findMany({
    where: and(isNull(initialBackups.finishedAt), lte(initialBackups.dueAt, now)),
  });
  const runs: Promise<void>[] = [];
  const minuteTs = Math.floor(now.getTime() / MINUTE);

  for (const row of due) {
    try {
      if (!(await acquireLock(`lock:initial-backup:${row.appId}:${minuteTs}`, 61_000))) continue;
      const facts = await gatherFacts(row, now);
      if (!facts) continue;
      const step = decideInitialStep(facts);

      if (step.kind === "finish") {
        await finish(row.appId, step.outcome, now);
        continue;
      }
      if (step.kind === "wait") {
        await db
          .update(initialBackups)
          .set({ dueAt: step.dueAt, ...(step.restartWindow ? { armedAt: now } : {}) })
          .where(eq(initialBackups.appId, row.appId));
        continue;
      }
      if (queued.has(step.jobId)) continue;

      // Claimed before the run, so a restart mid-run retries it later rather than never.
      await db
        .update(initialBackups)
        .set({ dueAt: new Date(now.getTime() + retryDelayMs(row.attempts + 1)) })
        .where(eq(initialBackups.appId, row.appId));
      queued.add(step.jobId);
      runs.push(withBackupSlot(limit, () => attempt(row, step.jobId)).finally(() => queued.delete(step.jobId)));
    } catch (err) {
      log.error(`First snapshot of ${row.appId} error:`, err);
    }
  }
  return runs;
}
