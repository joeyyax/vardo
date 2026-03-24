// ---------------------------------------------------------------------------
// Auto-Backup Configuration
//
// Provides two capabilities:
// 1. ensureHostBackupTarget() — on app startup, auto-creates a Host-level
//    backup target from config file or DB settings if none exists.
// 2. ensureAutoBackupJob() — after deploy detects persistent volumes,
//    auto-creates a daily backup job linked to the app.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { backupTargets, backupJobs, backupJobApps, volumes } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createHash } from "crypto";
import { getBackupStorageConfig } from "@/lib/system-settings";

// ---------------------------------------------------------------------------
// 1. Host-level backup target from config
// ---------------------------------------------------------------------------

/**
 * Check if a Host-level backup target exists. If not, but backup storage
 * is configured (via config file or DB), auto-create one. This is the
 * global safety-net target that any org can fall back to.
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

  // Use the canonical resolution chain: config file > DB > null
  const storageConfig = await getBackupStorageConfig();
  if (!storageConfig?.type || !storageConfig?.bucket || !storageConfig?.accessKey || !storageConfig?.secretKey) {
    return null;
  }

  // Validate storage type
  const validTypes = ["s3", "r2", "b2"] as const;
  const type = storageConfig.type.toLowerCase() as (typeof validTypes)[number];
  if (!validTypes.includes(type)) {
    console.warn(
      `[auto-backup] Invalid backup storage type: ${storageConfig.type}. Must be one of: ${validTypes.join(", ")}`
    );
    return null;
  }

  // Build the S3-compatible config
  const config = {
    bucket: storageConfig.bucket,
    region: storageConfig.region || "auto",
    accessKeyId: storageConfig.accessKey,
    secretAccessKey: storageConfig.secretKey,
    ...(storageConfig.endpoint ? { endpoint: storageConfig.endpoint } : {}),
  } satisfies {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
  };

  console.log(`[auto-backup] Creating Host-level backup target (${type}://${storageConfig.bucket})`);

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
// 2. System backup job for Vardo's own database
// ---------------------------------------------------------------------------

/**
 * Ensure a system backup job exists for Vardo's PostgreSQL database.
 * Requires a host-level backup target. Creates the job if none exists.
 *
 * Call this after ensureHostBackupTarget() succeeds.
 */
export async function ensureSystemBackupJob(targetId: string) {
  // Check if a system backup job already exists
  const existing = await db.query.backupJobs.findFirst({
    where: eq(backupJobs.isSystem, true),
  });

  if (existing) return existing;

  const jobId = nanoid();
  const [job] = await db
    .insert(backupJobs)
    .values({
      id: jobId,
      organizationId: null, // system-level, not org-scoped
      targetId,
      name: "Vardo database",
      schedule: staggeredSchedule("vardo-system-db"),
      enabled: true,
      isSystem: true,
      keepLast: 2,
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 3,
      notifyOnFailure: true,
    })
    .returning();

  console.log(`[auto-backup] Created system backup job for Vardo database`);
  return job;
}

// ---------------------------------------------------------------------------
// 3. Staggered schedule generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic staggered cron schedule from a seed string.
 * Spreads backups across midnight–5 AM to avoid thundering herd.
 */
function staggeredSchedule(seed: string): string {
  const hash = createHash("md5").update(seed).digest();
  const minute = hash[0] % 60;      // 0–59
  const hour = hash[1] % 6;         // 0–5 (midnight to 5 AM)
  return `${minute} ${hour} * * *`;
}

// ---------------------------------------------------------------------------
// 4. Auto-create backup job on deploy
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

  // Create a daily backup job with staggered schedule
  const jobId = nanoid();
  await db.insert(backupJobs).values({
    id: jobId,
    organizationId,
    targetId: target.id,
    name: `Auto: ${appName}`,
    schedule: staggeredSchedule(appId),
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
