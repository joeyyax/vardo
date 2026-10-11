// Web records each release's backup boot steps in Postgres; the worker's backup loops wait for that record.

import { and, eq, like, lt, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { getBuildSha } from "@/lib/version";

const log = logger.child("backup");

const PREFIX = "backup_boot:";
const KEEP_MS = 90 * 24 * 60 * 60_000;

export type CredentialStep = "encrypted" | "skipped" | "failed";

export const backupBootKey = (sha: string = getBuildSha()) => `${PREFIX}${sha.trim() || "dev"}`;

/** Records that web ran credential encryption, the interrupted-backup reap and the backup target for this release. */
export async function recordBackupBoot(credentials: CredentialStep, sha: string = getBuildSha(), now = new Date()): Promise<void> {
  const key = backupBootKey(sha);
  const value = JSON.stringify({ credentials, at: now.toISOString() });
  await db
    .insert(systemSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: now } });
  await db
    .delete(systemSettings)
    .where(and(like(systemSettings.key, `${PREFIX}%`), ne(systemSettings.key, key), lt(systemSettings.updatedAt, new Date(now.getTime() - KEEP_MS))));
}

/** Retries until the record is written, so a database blip can't hold the worker's backups back. */
export function recordBackupBootInBackground(credentials: CredentialStep, retryMs = 30_000): Promise<void> {
  return new Promise((resolve) => {
    const attempt = () =>
      recordBackupBoot(credentials).then(resolve, (err) => {
        log.warn(`Couldn't record backup boot steps, retrying in ${Math.round(retryMs / 1000)}s:`, err);
        setTimeout(attempt, retryMs).unref?.();
      });
    attempt();
  });
}

export async function backupBootRecorded(sha: string = getBuildSha()): Promise<boolean> {
  const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, backupBootKey(sha)), columns: { key: true } });
  return !!row;
}

/** Resolves once web has recorded this release's backup boot steps. Rejects when `stopped` turns true first. */
export async function waitForBackupBoot(opts: { stopped: () => boolean; pollMs?: number; sha?: string }): Promise<void> {
  const pollMs = opts.pollMs ?? 5000;
  let said = false;
  for (;;) {
    if (opts.stopped()) throw new Error("Stopped before the console recorded its backup boot steps");
    try {
      if (await backupBootRecorded(opts.sha)) {
        if (said) log.info("The console finished its backup boot steps; starting backup loops");
        return;
      }
    } catch (err) {
      log.warn("Couldn't read the backup boot record:", err instanceof Error ? err.message : err);
    }
    if (!said) log.info("Backup loops wait for the console's credential encryption and backup target");
    said = true;
    await new Promise<void>((r) => setTimeout(r, pollMs).unref?.());
  }
}
