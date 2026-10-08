// Storage and job for Vardo's own database backup. Shared by the setup wizard and the admin Backups tab.

import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs, backupJobVolumes, backupTargets, backups, volumes } from "@/lib/db/schema";
import { getBackupStorageConfig, setSystemSetting } from "@/lib/system-settings";
import { maskSecret, resolveSecret } from "@/lib/mask-secrets";
import { ensureSystemBackup } from "./auto-backup";
import { mergeTargetConfig, sealTargetConfig, maskTargetConfig, type TargetConfig } from "./target-config";
import { logger } from "@/lib/logger";

const log = logger.child("system-backup-storage");

const S3_FAMILY = ["s3", "r2", "b2"];

export const systemStorageSchema = z.object({
  type: z.enum(["s3", "r2", "b2"]),
  bucket: z.string().min(1, "Bucket name is required"),
  region: z.string().min(1, "Region is required"),
  endpoint: z.string().optional(),
  accessKey: z.string().optional(),
  secretKey: z.string().optional(),
}).strict();

export type SystemStorageInput = z.infer<typeof systemStorageSchema>;

/** A save the current state refuses; `message` is safe to show. */
export class SystemStorageConflict extends Error {}

async function fileManaged() {
  const { readVardoConfig } = await import("@/lib/config/vardo-config");
  return Boolean((await readVardoConfig())?.backup?.type);
}

/** The instance-level target the system job writes to: the job's own, else the first. */
async function findSystemTarget() {
  const job = await findSystemJob();
  if (job) {
    const target = await db.query.backupTargets.findFirst({ where: eq(backupTargets.id, job.targetId) });
    if (target) return target;
  }
  return (await db.query.backupTargets.findFirst({ where: isNull(backupTargets.organizationId) })) ?? null;
}

/** The job that dumps Vardo's own database, via the system "postgres" volume. */
export async function findSystemJob() {
  const [row] = await db
    .select({ job: backupJobs })
    .from(volumes)
    .innerJoin(backupJobVolumes, eq(backupJobVolumes.volumeId, volumes.id))
    .innerJoin(backupJobs, eq(backupJobs.id, backupJobVolumes.backupJobId))
    .where(and(isNull(volumes.appId), eq(volumes.name, "postgres")))
    .limit(1);
  return row?.job ?? null;
}

/** Current system backup storage with credentials masked. */
export async function readSystemBackupStorage() {
  const managedInFile = await fileManaged();
  const target = await findSystemTarget();

  if (target && !managedInFile) {
    const config = maskTargetConfig(target.config) as TargetConfig;
    const editable = S3_FAMILY.includes(target.type);
    return {
      configured: true,
      editable,
      managedInFile,
      target: { id: target.id, name: target.name, type: target.type },
      type: target.type,
      bucket: (config.bucket as string) ?? null,
      region: (config.region as string) ?? null,
      endpoint: (config.endpoint as string) ?? null,
      accessKey: (config.accessKeyId as string) ?? null,
      secretKey: (config.secretAccessKey as string) ?? null,
      // Non-S3 targets show their location instead.
      location: editable ? null : ((config.path as string) ?? (config.host as string) ?? null),
    };
  }

  const stored = await getBackupStorageConfig();
  if (!stored) {
    return { configured: false, editable: !managedInFile, managedInFile, target: null };
  }
  return {
    configured: true,
    editable: !managedInFile,
    managedInFile,
    target: target ? { id: target.id, name: target.name, type: target.type } : null,
    type: stored.type,
    bucket: stored.bucket ?? null,
    region: stored.region ?? null,
    endpoint: stored.endpoint ?? null,
    accessKey: maskSecret(stored.accessKey),
    secretKey: maskSecret(stored.secretKey),
    location: null,
  };
}

/** Save system backup storage, keep the system target in step and make sure the database job exists. */
export async function saveSystemBackupStorage(input: SystemStorageInput) {
  if (await fileManaged()) {
    throw new SystemStorageConflict("Backup storage is set in vardo.yml. Edit it there.");
  }
  const target = await findSystemTarget();
  if (target && !S3_FAMILY.includes(target.type)) {
    throw new SystemStorageConflict(
      `The system backup target "${target.name}" is ${target.type.toUpperCase()}. Delete it before setting S3 storage.`,
    );
  }

  const { type, bucket, region, endpoint, accessKey, secretKey } = input;
  const existing = await getBackupStorageConfig();

  await setSystemSetting("backup_storage", JSON.stringify({
    type,
    bucket,
    region,
    endpoint,
    accessKey: resolveSecret(accessKey, existing?.accessKey),
    secretKey: resolveSecret(secretKey, existing?.secretKey),
  }));

  // A target created before this save would otherwise keep the old bucket and keys.
  if (target) {
    const merged = mergeTargetConfig(target.config as TargetConfig, {
      bucket,
      region,
      ...(endpoint ? { endpoint } : {}),
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    });
    await db
      .update(backupTargets)
      .set({ type, config: sealTargetConfig(merged, null) as typeof backupTargets.$inferInsert.config, updatedAt: new Date() })
      .where(eq(backupTargets.id, target.id));
  }

  await ensureSystemBackup().catch((err) => log.error("System backup job setup failed:", err));
}

/** The system job with its target and the 20 most recent runs of Vardo's database. */
export async function readSystemBackupJob() {
  const job = await findSystemJob();
  const history = await db.query.backups.findMany({
    where: and(isNull(backups.appId), isNull(backups.organizationId)),
    orderBy: [desc(backups.startedAt)],
    limit: 20,
    columns: { archiveKey: false },
    with: { job: { columns: { id: true, name: true } } },
  });
  if (!job) return { job: null, history };

  const target = await db.query.backupTargets.findFirst({
    where: eq(backupTargets.id, job.targetId),
    columns: { id: true, name: true, type: true },
  });
  return { job: { ...job, target: target ?? null }, history };
}
