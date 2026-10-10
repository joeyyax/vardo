// Startup cleanup for backups a dead process left `running`: fail the row, remove its container and staging.

import { readdir, rm, stat } from "fs/promises";
import { join } from "path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import { dockerEnv } from "@/lib/docker/docker-env";
import { logger } from "@/lib/logger";
import { execFileAsync } from "@/lib/utils/exec";
import { BACKUPS_DIR, backupContainerName, backupWorkDir } from "./engine";
import { backupLeaseHeld } from "./run-lease";

const log = logger.child("backup");

export const INTERRUPTED_REASON =
  "Backup interrupted: the console process running it stopped, most likely a restart or self-deploy";

/** Staging untouched this long has no owner. Restores and drills finish well inside it. */
export const ORPHAN_STAGING_MS = 24 * 60 * 60 * 1000;

/**
 * Fail every pending or running backup no live process holds a lease on. Returns the IDs failed.
 * `minAgeMs` spares rows younger than that, for a sweep beside a live scheduler: a row exists just before its lease.
 */
export async function reapInterruptedBackups(now = new Date(), opts: { minAgeMs?: number } = {}): Promise<string[]> {
  const rows = await db.query.backups.findMany({
    where: inArray(backups.status, ["pending", "running"]),
    columns: { id: true, log: true, startedAt: true },
  });

  const reaped: string[] = [];
  for (const row of rows) {
    if (opts.minAgeMs && now.getTime() - row.startedAt.getTime() < opts.minAgeMs) continue;
    if (await backupLeaseHeld(row.id)) continue;

    const line = `[${now.toISOString()}] ${INTERRUPTED_REASON}`;
    await db
      .update(backups)
      .set({ status: "failed", finishedAt: now, log: row.log ? `${row.log}\n${line}` : line })
      // A run that finished meanwhile keeps its outcome.
      .where(and(eq(backups.id, row.id), inArray(backups.status, ["pending", "running"])));

    await execFileAsync("docker", ["rm", "-f", backupContainerName(row.id)], { env: dockerEnv(), timeout: 30_000 }).catch(
      () => {},
    );
    await rm(backupWorkDir(row.id), { recursive: true, force: true }).catch(() => {});
    reaped.push(row.id);
  }

  if (reaped.length > 0) log.warn(`Failed ${reaped.length} backup(s) a stopped process left running: ${reaped.join(", ")}`);
  return reaped;
}

/** Remove `.tmp-*` staging nothing has touched within ORPHAN_STAGING_MS. Returns the names removed. */
export async function sweepOrphanedStaging(now = Date.now()): Promise<string[]> {
  const entries = await readdir(BACKUPS_DIR, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(".tmp-")) continue;
    const dir = join(BACKUPS_DIR, entry.name);
    if (now - (await newestMtime(dir)) < ORPHAN_STAGING_MS) continue;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    removed.push(entry.name);
  }
  if (removed.length > 0) log.warn(`Removed ${removed.length} orphaned backup staging dir(s): ${removed.join(", ")}`);
  return removed;
}

/** Newest mtime of a dir and its direct children: a file still being written keeps the dir alive. */
async function newestMtime(dir: string): Promise<number> {
  let newest = (await stat(dir)).mtimeMs;
  for (const name of await readdir(dir).catch(() => [])) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (info && info.mtimeMs > newest) newest = info.mtimeMs;
  }
  return newest;
}
