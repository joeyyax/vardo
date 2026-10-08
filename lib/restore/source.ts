// The bucket a restore reads from: set at install, configured in settings or entered in the browser.

import { z } from "zod";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createBackupStorage } from "@/lib/backups/storage-factory";
import { targetConfigSchema, type TargetType } from "@/lib/backups/target-config";
import { readArchiveKeyId } from "@/lib/backups/archive-crypto";
import { fingerprintMasterKey } from "@/lib/crypto/key-fingerprint";
import { runningKeyFingerprint } from "@/lib/crypto/encrypt";
import { getBackupStorageConfig } from "@/lib/system-settings";
import { SYSTEM_BACKUP_PREFIX, checkKeyIds, systemBackupsFrom, type KeyCheck, type SystemBackup } from "./plan";

export type RestoreTarget = { type: TargetType; config: Record<string, unknown> };

export const restoreTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("s3"), config: targetConfigSchema("s3") }),
  z.object({ type: z.literal("r2"), config: targetConfigSchema("r2") }),
  z.object({ type: z.literal("b2"), config: targetConfigSchema("b2") }),
  z.object({ type: z.literal("local"), config: targetConfigSchema("local") }),
]);

/** 64 hex characters, as install.sh generates it. */
export const masterKeySchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{64}$/, "The master key is 64 hex characters");

/** Storage set at install (VARDO_BACKUP_*), then the instance's backup settings. Null when neither. */
export async function configuredRestoreTarget(env = process.env): Promise<RestoreTarget | null> {
  const type = env.VARDO_BACKUP_TYPE?.toLowerCase();
  if (type === "local" && env.VARDO_BACKUP_PATH) {
    return { type: "local", config: { path: env.VARDO_BACKUP_PATH } };
  }
  if ((type === "s3" || type === "r2" || type === "b2") && env.VARDO_BACKUP_BUCKET) {
    const parsed = restoreTargetSchema.safeParse({
      type,
      config: {
        bucket: env.VARDO_BACKUP_BUCKET,
        region: env.VARDO_BACKUP_REGION || "auto",
        accessKeyId: env.VARDO_BACKUP_ACCESS_KEY,
        secretAccessKey: env.VARDO_BACKUP_SECRET_KEY,
        ...(env.VARDO_BACKUP_ENDPOINT ? { endpoint: env.VARDO_BACKUP_ENDPOINT } : {}),
        ...(env.VARDO_BACKUP_PREFIX ? { prefix: env.VARDO_BACKUP_PREFIX } : {}),
      },
    });
    if (parsed.success) return parsed.data;
  }

  const stored = await getBackupStorageConfig().catch(() => null);
  if (stored?.type && stored.bucket && stored.accessKey && stored.secretKey) {
    const parsed = restoreTargetSchema.safeParse({
      type: stored.type.toLowerCase(),
      config: {
        bucket: stored.bucket,
        region: stored.region || "auto",
        accessKeyId: stored.accessKey,
        secretAccessKey: stored.secretKey,
        ...(stored.endpoint ? { endpoint: stored.endpoint } : {}),
      },
    });
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** Plain-language name of a target, without credentials. */
export function describeTarget(target: RestoreTarget): string {
  if (target.type === "local") return `Local folder ${String(target.config.path)}`;
  const label = { s3: "S3", r2: "R2", b2: "B2" }[target.type as "s3" | "r2" | "b2"];
  return `${label} bucket ${String(target.config.bucket)}`;
}

/** Every system backup in the target, newest first. */
export async function listSystemBackups(target: RestoreTarget): Promise<SystemBackup[]> {
  const storage = createBackupStorage({ ...target, organizationId: null });
  return systemBackupsFrom(await storage.list(SYSTEM_BACKUP_PREFIX));
}

/** Download a system backup far enough to read its Key ID, then compare it with the entered key. */
export async function checkBackupKey(
  target: RestoreTarget,
  backupKey: string,
  masterKey: string,
): Promise<KeyCheck> {
  if (!backupKey.startsWith(SYSTEM_BACKUP_PREFIX)) throw new Error("That isn't a system backup");
  const dir = await mkdtemp(join(tmpdir(), "vardo-restore-check-"));
  try {
    const path = join(dir, "archive");
    await createBackupStorage({ ...target, organizationId: null }).download(backupKey, path);
    return checkKeyIds({
      archiveKeyId: await readArchiveKeyId(path),
      enteredKeyId: fingerprintMasterKey(masterKey),
      runningKeyId: runningKeyFingerprint(),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
