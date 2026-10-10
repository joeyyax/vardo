// Backup results batched per org, sent as one summary per run window. State lives in `backup_batch`.

import { Cron } from "croner";
import { and, desc, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { backupBatches, backupJobs, backups } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { emit } from "@/lib/notifications/dispatch";
import { readOrgNotificationSettings } from "@/lib/notifications/preferences";
import {
  FAILURE_FLUSH_MS,
  flushDeadline,
  MAX_SUMMARY_ROWS,
  needsAttention,
  opensBatch,
  shouldFlush,
  summarizeBatch,
  volumeKey,
  type BackupBatchItem,
} from "./batch-rules";

const log = logger.child("backup-batch");

/** Earlier sizes a summary compares against. */
const HISTORY_RUNS = 6;
const HISTORY_DAYS = 30;
/** A volume backed up this recently counts as still covered. */
const COVERED_DAYS = 7;
/** Covered with no success this long is stale. */
const STALE_MS = 48 * 60 * 60_000;

/** Adds results to the org's open batch, opening one when needed. Never throws. */
export async function recordBackupResults(organizationId: string, items: BackupBatchItem[], now = Date.now()): Promise<void> {
  if (items.length === 0) return;
  try {
    const failed = items.some((i) => i.outcome === "failed");
    for (let attempt = 0; attempt < 3; attempt++) {
      const open = await db.query.backupBatches.findFirst({
        where: and(eq(backupBatches.organizationId, organizationId), isNull(backupBatches.flushedAt)),
        columns: { id: true, flushAt: true },
      });

      if (open) {
        const flushAt = failed ? Math.min(open.flushAt.getTime(), now + FAILURE_FLUSH_MS) : open.flushAt.getTime();
        const appended = await db
          .update(backupBatches)
          .set({ items: sql`${backupBatches.items} || ${JSON.stringify(items)}::jsonb`, flushAt: new Date(flushAt) })
          .where(and(eq(backupBatches.id, open.id), isNull(backupBatches.flushedAt)))
          .returning({ id: backupBatches.id });
        if (appended.length > 0) return;
        continue;
      }

      if (!items.some(opensBatch)) return;
      const { batchWindowMinutes } = await readOrgNotificationSettings(organizationId);
      const opened = await db
        .insert(backupBatches)
        .values({
          id: nanoid(),
          organizationId,
          openedAt: new Date(now),
          flushAt: new Date(flushDeadline(now, batchWindowMinutes * 60_000, failed ? now : null)),
          items,
        })
        .onConflictDoNothing()
        .returning({ id: backupBatches.id });
      if (opened.length > 0) return;
    }
    log.warn(`Couldn't batch ${items.length} result(s) for org ${organizationId}`);
  } catch (err) {
    log.error(`Couldn't batch backup results for org ${organizationId}:`, err);
  }
}

/** Whether the org has a backup running or queued, and when its next job is due. */
async function orgActivity(organizationId: string, now: number): Promise<{ running: boolean; nextScheduledAt: number | null }> {
  const { STALE_RUN_MS } = await import("./engine");
  const { queuedBackupJobIds } = await import("./tick");
  const jobs = await db.query.backupJobs.findMany({
    where: and(eq(backupJobs.organizationId, organizationId), eq(backupJobs.enabled, true)),
    columns: { id: true, schedule: true },
  });
  const queued = queuedBackupJobIds();
  const inFlight = await db.query.backups.findFirst({
    where: and(
      eq(backups.organizationId, organizationId),
      inArray(backups.status, ["pending", "running"]),
      gt(backups.startedAt, new Date(now - STALE_RUN_MS)),
    ),
    columns: { id: true },
  });

  let nextScheduledAt: number | null = null;
  for (const job of jobs) {
    try {
      const next = new Cron(job.schedule.trim()).nextRun(new Date(now))?.getTime();
      if (next !== undefined && (nextScheduledAt === null || next < nextScheduledAt)) nextScheduledAt = next;
    } catch {
      // Unparseable schedule.
    }
  }
  return { running: Boolean(inFlight) || jobs.some((j) => queued.has(j.id)), nextScheduledAt };
}

/** Earlier successful sizes per volume, oldest first, leaving out this batch's own archives. */
async function loadHistory(organizationId: string, items: BackupBatchItem[], now: number): Promise<Map<string, number[]>> {
  const backed = items.filter((i) => i.kind === "backup");
  const history = new Map<string, number[]>();
  if (backed.length === 0) return history;
  const exclude = backed.flatMap((i) => (i.backupId ? [i.backupId] : []));
  const rows = await db
    .select({ appId: backups.appId, volumeName: backups.volumeName, size: backups.sizeBytes })
    .from(backups)
    .where(
      and(
        eq(backups.organizationId, organizationId),
        eq(backups.status, "success"),
        inArray(backups.volumeName, [...new Set(backed.map((i) => i.volumeName))]),
        gt(backups.startedAt, new Date(now - HISTORY_DAYS * 86_400_000)),
        ...(exclude.length ? [notInArray(backups.id, exclude)] : []),
      ),
    )
    .orderBy(desc(backups.startedAt));
  for (const row of rows) {
    const key = volumeKey(row.appId, row.volumeName ?? "");
    const sizes = history.get(key) ?? [];
    if (sizes.length < HISTORY_RUNS) sizes.unshift(row.size ?? 0);
    history.set(key, sizes);
  }
  return history;
}

/** Volumes backed up this week with no success in 48 hours. */
async function loadStaleVolumes(organizationId: string, now: number) {
  const rows = await db
    .select({
      appName: backups.appName,
      volumeName: backups.volumeName,
      lastSuccess: sql<Date | null>`max(${backups.finishedAt}) filter (where ${backups.status} = 'success')`.mapWith((v) => (v ? new Date(v) : null)),
    })
    .from(backups)
    .where(and(eq(backups.organizationId, organizationId), gt(backups.startedAt, new Date(now - COVERED_DAYS * 86_400_000))))
    .groupBy(backups.appId, backups.appName, backups.volumeName);
  return rows
    .filter((r) => r.volumeName && (!r.lastSuccess || now - r.lastSuccess.getTime() > STALE_MS))
    .map((r) => ({ appName: r.appName ?? r.volumeName!, volumeName: r.volumeName!, lastSuccessAt: r.lastSuccess?.toISOString() ?? null }));
}

async function sendSummary(organizationId: string, items: BackupBatchItem[], now: number): Promise<void> {
  const [settings, history, staleVolumes] = await Promise.all([
    readOrgNotificationSettings(organizationId),
    loadHistory(organizationId, items, now),
    loadStaleVolumes(organizationId, now),
  ]);
  const rows = summarizeBatch(items, history);
  if (rows.length === 0) return;
  if (!settings.categories.backups && !needsAttention(rows, staleVolumes.length)) return;

  const backed = rows.filter((r) => r.kind === "backup");
  const succeeded = backed.filter((r) => r.outcome === "success").length;
  const failed = rows.filter((r) => r.outcome === "failed").length;
  const times = items.map((i) => i.at).sort();
  emit(organizationId, {
    type: "backup.summary",
    title: failed > 0 ? `Backups: ${failed} failed` : `Backups: ${succeeded} finished`,
    message: `${succeeded} of ${backed.length} backups succeeded${failed ? `, ${failed} failed` : ""}.`,
    windowStart: times[0],
    windowEnd: times.at(-1)!,
    succeeded,
    failed: backed.filter((r) => r.outcome === "failed").length,
    skipped: backed.filter((r) => r.outcome === "skipped").length,
    totalSize: backed.reduce((sum, r) => sum + (r.outcome === "success" ? r.sizeBytes : 0), 0),
    durationMs: backed.reduce((sum, r) => sum + r.durationMs, 0),
    rows: rows.slice(0, MAX_SUMMARY_ROWS),
    hiddenRows: rows.length > MAX_SUMMARY_ROWS ? rows.length - MAX_SUMMARY_ROWS : undefined,
    staleVolumes: staleVolumes.length ? staleVolumes : undefined,
  });
}

/** Sends every batch that's due. Safe to run from more than one process. */
export async function flushBackupBatches(now = Date.now()): Promise<void> {
  const open = await db.query.backupBatches.findMany({
    where: isNull(backupBatches.flushedAt),
    columns: { id: true, organizationId: true, flushAt: true },
  });
  for (const batch of open) {
    try {
      const activity = await orgActivity(batch.organizationId, now);
      if (!shouldFlush(batch.flushAt.getTime(), now, activity)) continue;
      const [claimed] = await db
        .update(backupBatches)
        .set({ flushedAt: new Date(now) })
        .where(and(eq(backupBatches.id, batch.id), isNull(backupBatches.flushedAt)))
        .returning({ items: backupBatches.items });
      if (claimed) await sendSummary(batch.organizationId, claimed.items, now);
    } catch (err) {
      log.error(`Backup batch ${batch.id} failed to send:`, err);
    }
  }
}
