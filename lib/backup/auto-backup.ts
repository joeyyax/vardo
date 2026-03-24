// ---------------------------------------------------------------------------
// Auto-Backup Configuration
//
// Provides two capabilities:
// 1. ensureHostBackupTarget() — on app startup, auto-creates a Host-level
//    backup target from BACKUP_STORAGE_* env vars if none exists.
// 2. ensureAutoBackupJob() — after deploy detects persistent volumes,
//    auto-creates a daily backup job linked to the app.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { backupTargets, backupJobs, backupJobApps, volumes } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";

// ---------------------------------------------------------------------------
// 1. Host-level backup target from env vars
// ---------------------------------------------------------------------------

/**
 * Check if a Host-level backup target exists. If not, but BACKUP_STORAGE_*
 * env vars are configured, auto-create one. This is the global safety-net
 * target that any org can fall back to.
 *
 * Returns the Host-level target if one exists (or was created), null otherwise.
 */
export async function ensureHostBackupTarget() {
  // Check if a Host-level target already exists (organizationId IS NULL)
  const existing = await db.query.backupTargets.findFirst({
    where: isNull(backupTargets.organizationId),
  });

  if (existing) {
    return existing;
  }

  // Check env vars
  const storageType = process.env.BACKUP_STORAGE_TYPE;
  const bucket = process.env.BACKUP_STORAGE_BUCKET;
  const region = process.env.BACKUP_STORAGE_REGION;
  const endpoint = process.env.BACKUP_STORAGE_ENDPOINT;
  const accessKey = process.env.BACKUP_STORAGE_ACCESS_KEY;
  const secretKey = process.env.BACKUP_STORAGE_SECRET_KEY;

  if (!storageType || !bucket || !accessKey || !secretKey) {
    // Not enough config to create a target
    return null;
  }

  // Validate storage type
  const validTypes = ["s3", "r2", "b2"] as const;
  const type = storageType.toLowerCase() as (typeof validTypes)[number];
  if (!validTypes.includes(type)) {
    console.warn(
      `[auto-backup] Invalid BACKUP_STORAGE_TYPE: ${storageType}. Must be one of: ${validTypes.join(", ")}`
    );
    return null;
  }

  // Build the S3-compatible config
  const config = {
    bucket,
    region: region || "auto",
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    ...(endpoint ? { endpoint } : {}),
  } satisfies {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
  };

  console.log(`[auto-backup] Creating Host-level backup target (${type}://${bucket})`);

  const [target] = await db
    .insert(backupTargets)
    .values({
      id: nanoid(),
      organizationId: null, // Host-level
      name: "System default",
      type,
      config,
      isDefault: true,
    })
    .returning();

  return target;
}

// ---------------------------------------------------------------------------
// 2. Auto-create backup job on deploy
// ---------------------------------------------------------------------------

/**
 * Resolve the best backup target for an organization:
 * 1. Org-level default target (takes precedence)
 * 2. Host-level target (fallback safety net)
 * Returns null if no target is configured anywhere.
 */
export async function resolveBackupTarget(organizationId: string) {
  // Check for org-level default target first
  const orgTarget = await db.query.backupTargets.findFirst({
    where: and(
      eq(backupTargets.organizationId, organizationId),
      eq(backupTargets.isDefault, true),
    ),
  });

  if (orgTarget) return orgTarget;

  // Fall back to any org-level target
  const anyOrgTarget = await db.query.backupTargets.findFirst({
    where: eq(backupTargets.organizationId, organizationId),
  });

  if (anyOrgTarget) return anyOrgTarget;

  // Fall back to system-level target
  const hostTarget = await db.query.backupTargets.findFirst({
    where: isNull(backupTargets.organizationId),
  });

  return hostTarget ?? null;
}

/**
 * After a deploy detects persistent volumes, check if the app already has a
 * backup job. If not and a backup target exists (org-level or Host-level),
 * auto-create a daily backup job.
 *
 * Returns the created job ID, or null if skipped.
 */
export async function ensureAutoBackupJob(opts: {
  appId: string;
  appName: string;
  organizationId: string;
}): Promise<string | null> {
  const { appId, appName, organizationId } = opts;

  // Check if the app has persistent volumes
  const appVolumes = await db.query.volumes.findMany({
    where: eq(volumes.appId, appId),
  });
  const hasPersistentVolumes = appVolumes.some((v) => v.persistent);

  if (!hasPersistentVolumes) {
    return null;
  }

  // Check if the app already has a backup job
  const existingLink = await db.query.backupJobApps.findFirst({
    where: eq(backupJobApps.appId, appId),
  });

  if (existingLink) {
    return null; // Already covered
  }

  // Resolve the best backup target
  const target = await resolveBackupTarget(organizationId);

  if (!target) {
    // No backup target configured anywhere -- skip silently
    return null;
  }

  // Create a daily backup job at 2 AM
  const jobId = nanoid();
  await db.insert(backupJobs).values({
    id: jobId,
    organizationId,
    targetId: target.id,
    name: `Auto: ${appName}`,
    schedule: "0 2 * * *",
    enabled: true,
    keepLast: 1,
    keepDaily: 7,
    keepWeekly: 1,
    keepMonthly: 1,
    notifyOnFailure: true,
  });

  // Link the app to the job
  await db.insert(backupJobApps).values({
    backupJobId: jobId,
    appId,
  });

  return jobId;
}
