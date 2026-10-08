// Phase one: put Vardo's own database back from a system backup, then hand off to the app queue.

import { randomBytes } from "crypto";
import { nanoid } from "nanoid";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs, backupTargets, backups, cronJobs, volumes } from "@/lib/db/schema";
import { instanceRestores } from "@/lib/db/schema/restore";
import { restoreBackup } from "@/lib/backups/engine";
import { buildSystemDumpMeta } from "@/lib/backups/auto-backup";
import { sealTargetConfig } from "@/lib/backups/target-config";
import { SYSTEM_DB_VOLUME_NAME } from "@/lib/backups/key-guard";
import { execFileAsync } from "@/lib/utils/exec";
import { needsSetup } from "@/lib/setup";
import { logger } from "@/lib/logger";
import { backupTimeFromKey } from "./plan";
import { checkSystemBackup, type RestoreTarget } from "./source";
import { clearMarker, hashToken, readMarker, writeMarker, type RestoreMarker } from "./marker";
import { buildRestoreQueue } from "./queue";
import { kickRestoreWorker } from "./worker";

const log = logger.child("instance-restore");

const g = globalThis as unknown as { __vardo_db_restore?: Promise<void> };

/** Clears the fresh schema in the same transaction as the dump, so a failed restore changes nothing. */
export function wrapSystemRestoreCmd(restoreCmd: string): string {
  const atomic = restoreCmd.replace(" -v ON_ERROR_STOP=1 ", " -v ON_ERROR_STOP=1 --single-transaction ");
  return `{ printf 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;\\n'; cat; } | ${atomic}`;
}

export class RestoreRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreRefusedError";
  }
}

/** Check the key, then restore the database in the background. Returns the token the caller's browser keeps. */
export async function startInstanceRestore(args: {
  target: RestoreTarget;
  backupKey: string;
  masterKey: string;
}): Promise<{ runId: string; token: string }> {
  if (!(await needsSetup())) throw new RestoreRefusedError("This instance is already set up. A restore only runs on a fresh install.");
  const existing = await readMarker();
  if (existing?.phase === "database" || g.__vardo_db_restore) {
    throw new RestoreRefusedError("A restore is already running.");
  }

  const { key: check, authSecret } = await checkSystemBackup(args.target, args.backupKey, args.masterKey);
  if (check.kind === "wrong-key") {
    throw new RestoreRefusedError(
      `This backup was written with Key ID ${check.archiveKeyId}, but the key you entered is ${check.enteredKeyId}.`,
    );
  }
  if (check.kind === "not-loaded") {
    throw new RestoreRefusedError(
      `This instance is running Key ID ${check.runningKeyId ?? "none"}. Load key ${check.keyId} with sudo vardo key set, then reload this page.`,
    );
  }

  if (authSecret?.kind === "mismatch") {
    throw new RestoreRefusedError(
      "This backup's two-factor secrets don't open with this instance's BETTER_AUTH_SECRET. Load the escrowed one with sudo vardo key set, then reload this page.",
    );
  }

  const takenAt = backupTimeFromKey(args.backupKey) ?? new Date();
  const token = randomBytes(24).toString("base64url");
  const marker: RestoreMarker = {
    runId: nanoid(),
    phase: "database",
    systemBackupKey: args.backupKey,
    systemBackupAt: takenAt.toISOString(),
    startedAt: new Date().toISOString(),
    tokenHash: hashToken(token),
  };
  await writeMarker(marker);

  g.__vardo_db_restore = restoreDatabase(marker, args.target, check.kind === "match" ? check.keyId : null)
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Instance restore failed: ${message}`);
      await writeMarker({ ...marker, phase: "failed", error: message }).catch(() => {});
    })
    .finally(() => {
      g.__vardo_db_restore = undefined;
    });

  return { runId: marker.runId, token };
}

/** Register the archive in the fresh database, so the engine's restore path runs on it unchanged. */
async function stageSystemBackup(target: RestoreTarget, backupKey: string, keyId: string | null): Promise<string> {
  const targetId = nanoid();
  await db.insert(backupTargets).values({
    id: targetId,
    organizationId: null,
    name: "Restore source",
    type: target.type,
    config: sealTargetConfig(target.config, null) as typeof backupTargets.$inferInsert.config,
  });

  const meta = buildSystemDumpMeta();
  const backupMeta = { dumpCmd: meta.dumpCmd, restoreCmd: wrapSystemRestoreCmd(meta.restoreCmd) };
  const existing = await db.query.volumes.findFirst({
    where: and(isNull(volumes.appId), eq(volumes.name, SYSTEM_DB_VOLUME_NAME)),
  });
  if (existing) {
    await db.update(volumes).set({ backupMeta, backupSpec: null }).where(eq(volumes.id, existing.id));
  } else {
    await db.insert(volumes).values({
      id: nanoid(),
      appId: null,
      organizationId: null,
      name: SYSTEM_DB_VOLUME_NAME,
      mountPath: "/var/lib/postgresql/data",
      persistent: true,
      backupStrategy: "dump",
      backupMeta,
    });
  }

  const backupId = nanoid();
  await db.insert(backups).values({
    id: backupId,
    targetId,
    status: "success",
    volumeName: SYSTEM_DB_VOLUME_NAME,
    strategy: "dump",
    storagePath: backupKey,
    keyFingerprint: keyId,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  return backupId;
}

/** psql's own error when there is one, else the engine's last word. */
export function databaseFailureReason(log: string): string {
  const lines = log.split("\n");
  const psql = lines.find((l) => /^(psql:.*)?ERROR:/.test(l.trim()));
  if (psql) return `Postgres refused the dump: ${psql.replace(/^.*ERROR:\s*/, "")}`;
  const engine = [...lines].reverse().find((l) => l.includes("Restore failed:"));
  const reason = engine?.replace(/^\[[^\]]+\] Restore failed: /, "");
  if (!reason || reason.startsWith("Command failed:")) return "The database restore failed";
  return reason;
}

/** Bring the restored schema up to this version's. */
export async function runMigrations(logFn: (msg: string) => void): Promise<void> {
  logFn("Running migrations on the restored database");
  const { stdout } = await execFileAsync(process.execPath, ["scripts/migrate.mjs"], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 600_000,
  });
  const applied = String(stdout).split("\n").filter((l) => l.includes("Applied")).length;
  logFn(`Migrations done (${applied} applied)`);
}

async function restoreDatabase(marker: RestoreMarker, target: RestoreTarget, keyId: string | null): Promise<void> {
  const backupId = await stageSystemBackup(target, marker.systemBackupKey, keyId);
  log.info(`Restoring Vardo's database from ${marker.systemBackupKey}`);

  const result = await restoreBackup(backupId, { afterRestore: runMigrations });
  if (!result.success) {
    await writeMarker({ ...marker, phase: "failed", error: databaseFailureReason(result.log), log: result.log });
    return;
  }

  await finishDatabasePhase(marker, result.log);
}

/** After the dump is in: pause the old jobs, queue the apps, start the worker. Safe to repeat. */
export async function finishDatabasePhase(marker: RestoreMarker, databaseLog: string): Promise<void> {
  // The old box may still be writing to the same bucket. Nothing scheduled runs until resumed.
  const pausedBackups = await db
    .update(backupJobs)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(backupJobs.enabled, true))
    .returning({ id: backupJobs.id });
  const pausedCrons = await db
    .update(cronJobs)
    .set({ enabled: false })
    .where(eq(cronJobs.enabled, true))
    .returning({ id: cronJobs.id });

  const existing = await db.query.instanceRestores.findFirst({ where: eq(instanceRestores.id, marker.runId) });
  if (!existing) {
    await db.insert(instanceRestores).values({
      id: marker.runId,
      systemBackupKey: marker.systemBackupKey,
      systemBackupAt: new Date(marker.systemBackupAt),
      databaseLog,
      pausedBackupJobIds: pausedBackups.map((j) => j.id),
      pausedCronJobIds: pausedCrons.map((j) => j.id),
      startedAt: new Date(marker.startedAt),
    });
    await buildRestoreQueue(marker.runId, new Date(marker.systemBackupAt));
  }
  await clearMarker();
  await refreshRestoredState();
  log.info("Vardo's database is restored. Restoring apps.");
  kickRestoreWorker();
}

/** Drop in-process caches that still describe the fresh database. */
async function refreshRestoredState(): Promise<void> {
  const { invalidateSettingsCache } = await import("@/lib/system-settings");
  invalidateSettingsCache();
  const { loadFeatureFlags } = await import("@/lib/config/features");
  const { loadAuthMethods } = await import("@/lib/config/auth-methods");
  const { refreshSetupState } = await import("@/lib/auth");
  await Promise.allSettled([loadFeatureFlags(), loadAuthMethods(), refreshSetupState()]);
}

/** At boot: finish a database phase the restart interrupted, then resume the app queue. */
export async function resumeInstanceRestore(): Promise<void> {
  const marker = await readMarker();
  // The dump committed but migrating it failed. Entrypoint migrations ran before this boot.
  if (marker?.phase === "failed" && !(await needsSetup())) {
    await finishDatabasePhase(marker, marker.log ?? "");
    return;
  }
  if (marker?.phase === "database") {
    if (await needsSetup()) {
      await writeMarker({
        ...marker,
        phase: "failed",
        error: "Vardo restarted before the database restore finished. Nothing was changed. Start the restore again.",
      });
    } else {
      // The dump committed before the restart. Entrypoint migrations already ran.
      await finishDatabasePhase(marker, "Vardo restarted after the database restore committed.");
      return;
    }
  }
  kickRestoreWorker({ requeueInterrupted: true });
}
