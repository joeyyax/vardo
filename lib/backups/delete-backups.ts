import { count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs, backups, backupTargets } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { createBackupStorage } from "./storage-factory";
import { ArchiveMissingError, type BackupStorage } from "./storage-port";

const log = logger.child("backup-delete");

export type DeletableBackup = {
  id: string;
  targetId: string;
  status: string;
  storagePath: string | null;
};

type Target = Parameters<typeof createBackupStorage>[0];

/** Bytes still held in storage: successful archives only. */
export const storedBytes = sql<number>`coalesce(sum(${backups.sizeBytes}) filter (where ${backups.status} = 'success'), 0)::bigint`;

/** A pending or running backup is still being written. */
export function isInProgress(status: string) {
  return status === "pending" || status === "running";
}

/** Whether the row still points at an archive in storage. */
function holdsArchive(row: DeletableBackup) {
  return !!row.storagePath && row.status !== "pruned";
}

/** Delete each row's archive from the target. Returns the ids whose archive is gone. */
export async function removeArchives(target: Target, rows: DeletableBackup[]) {
  const removed: string[] = [];
  const failed: string[] = [];
  let storage: BackupStorage | null = null;
  let openError: unknown = null;
  try {
    if (rows.some(holdsArchive)) storage = createBackupStorage(target);
  } catch (err) {
    openError = err;
  }

  for (const row of rows) {
    if (!holdsArchive(row)) {
      removed.push(row.id);
      continue;
    }
    if (!storage) {
      log.warn(`Can't open target ${target.name} to delete ${row.storagePath}: ${String(openError)}`);
      failed.push(row.id);
      continue;
    }
    try {
      await storage.delete(row.storagePath!);
      removed.push(row.id);
    } catch (err) {
      if (err instanceof ArchiveMissingError) {
        removed.push(row.id);
        continue;
      }
      log.warn(`Failed to delete ${row.storagePath} from ${target.name}: ${String(err)}`);
      failed.push(row.id);
    }
  }
  return { removed, failed };
}

/** Delete each backup's archive, then its row. A row whose archive won't delete is kept. */
export async function deleteBackups(rows: DeletableBackup[]) {
  const targetIds = [...new Set(rows.map((r) => r.targetId))];
  const targets = targetIds.length
    ? await db.query.backupTargets.findMany({ where: inArray(backupTargets.id, targetIds) })
    : [];

  const removed: string[] = [];
  const failed: string[] = [];
  for (const target of targets) {
    const result = await removeArchives(
      target,
      rows.filter((r) => r.targetId === target.id),
    );
    removed.push(...result.removed);
    failed.push(...result.failed);
  }

  if (removed.length > 0) {
    await db.delete(backups).where(inArray(backups.id, removed));
  }
  return { deleted: removed.length, kept: failed.length };
}

/** What deleting a target takes with it, across every org. */
export async function targetUsage(targetId: string, orgId: string) {
  const [stats] = await db
    .select({
      backups: count(),
      bytes: storedBytes,
      inProgress: sql<number>`count(*) filter (where ${backups.status} in ('pending', 'running'))::int`,
    })
    .from(backups)
    .where(eq(backups.targetId, targetId));

  const jobs = await db.query.backupJobs.findMany({
    where: eq(backupJobs.targetId, targetId),
    columns: { name: true, organizationId: true },
  });

  return {
    backups: Number(stats?.backups ?? 0),
    bytes: Number(stats?.bytes ?? 0),
    inProgress: Number(stats?.inProgress ?? 0),
    jobs: jobs.length,
    // Other orgs' job names stay private.
    jobNames: jobs.filter((j) => j.organizationId === orgId).map((j) => j.name),
  };
}

export type TargetUsage = Awaited<ReturnType<typeof targetUsage>>;

export function targetInUse(usage: TargetUsage) {
  return usage.backups > 0 || usage.jobs > 0;
}

/** Delete a target with its archives, rows and jobs. Returns archives left in storage. */
export async function deleteTargetAndBackups(target: Target & { id: string }) {
  const rows = await db.query.backups.findMany({
    where: eq(backups.targetId, target.id),
    columns: { id: true, targetId: true, status: true, storagePath: true },
  });
  const { failed } = await removeArchives(target, rows);

  await db.transaction(async (tx) => {
    await tx.delete(backups).where(eq(backups.targetId, target.id));
    await tx.delete(backupJobs).where(eq(backupJobs.targetId, target.id));
    await tx.delete(backupTargets).where(eq(backupTargets.id, target.id));
  });

  return { backups: rows.length, archivesLeft: failed.length };
}
