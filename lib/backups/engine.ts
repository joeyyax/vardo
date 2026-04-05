import { db } from "@/lib/db";
import {
  backupJobs,
  backups,
  volumes,
} from "@/lib/db/schema";
import { eq, and, isNull, desc, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, rm, stat } from "fs/promises";
import { resolve, join } from "path";
import type { BackupStorage } from "./storage-port";
import { createBackupStorage } from "./storage-factory";
import { assertSafeName } from "@/lib/docker/validate";
import { logger } from "@/lib/logger";

const log = logger.child("backup");

const execFileAsync = promisify(execFile);

const BACKUPS_DIR = resolve(process.env.VARDO_BACKUPS_DIR || "./.host/backups");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupResult = {
  backupId: string;
  appId: string;
  volumeName: string;
  success: boolean;
  sizeBytes: number;
  storagePath: string;
  error?: string;
  durationMs: number;
};

type VolumeToBackup = {
  id: string;
  name: string;
  appId: string | null;
  appName: string | null;
  orgSlug: string | null;
  backupStrategy: string;
  backupMeta: { dumpCmd: string; restoreCmd: string } | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** SHA-256 checksum of a file. */
async function checksumFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

const MIN_VALID_GZIP_BYTES = 100; // gzip header alone is 10 bytes; a real dump is several KB

/**
 * Verify a gzipped archive is valid:
 * - Not empty or suspiciously small (broken pipe, missing container)
 * - Passes gzip integrity check (not truncated or corrupted)
 */
async function verifyArchive(filePath: string, label: string): Promise<number> {
  const info = await stat(filePath);
  if (info.size < MIN_VALID_GZIP_BYTES) {
    throw new Error(
      `${label} produced a ${info.size}-byte file — too small to be valid, backup aborted`
    );
  }

  // gzip -t validates the entire compressed stream
  try {
    await execFileAsync("gzip", ["-t", filePath], { timeout: 300_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} archive is corrupt (gzip -t failed): ${msg}`);
  }

  return info.size;
}

// ---------------------------------------------------------------------------
// Core: backup strategies
// ---------------------------------------------------------------------------

/**
 * Strategy: tar — create a tar.gz of a Docker volume.
 */
async function backupVolumeTar(
  dockerVolumeName: string,
  storageKey: string,
  storage: BackupStorage,
  logFn: (msg: string) => void,
): Promise<{ sizeBytes: number; checksum: string }> {
  const tmpDir = join(BACKUPS_DIR, `.tmp-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const archiveFile = "volume.tar.gz";

  try {
    assertSafeName(dockerVolumeName);

    logFn(`Archiving volume ${dockerVolumeName}`);
    await execFileAsync(
      "docker",
      ["run", "--rm", "-v", `${dockerVolumeName}:/data`, "-v", `${tmpDir}:/backup`, "alpine", "tar", "czf", `/backup/${archiveFile}`, "-C", "/data", "."],
      { timeout: 600_000 },
    );

    const archivePath = join(tmpDir, archiveFile);
    await verifyArchive(archivePath, `Volume ${dockerVolumeName}`);

    const checksum = await checksumFile(archivePath);
    logFn(`Checksum: sha256:${checksum.slice(0, 16)}...`);

    logFn(`Uploading to ${storageKey}`);
    const { sizeBytes } = await storage.upload(storageKey, archivePath);

    logFn(`Upload complete (${sizeBytes} bytes)`);
    return { sizeBytes, checksum };
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Strategy: dump — run a configurable dump command and gzip the output.
 * The dumpCmd should produce output to stdout (e.g. "docker exec pg pg_dump -U user db").
 */
async function backupVolumeDump(
  dumpCmd: string,
  storageKey: string,
  storage: BackupStorage,
  logFn: (msg: string) => void,
): Promise<{ sizeBytes: number; checksum: string }> {
  const tmpDir = join(BACKUPS_DIR, `.tmp-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const dumpFile = join(tmpDir, "dump.gz");

  try {
    logFn(`Running dump: ${dumpCmd}`);
    await execFileAsync(
      "bash",
      ["-c", `set -o pipefail; ${dumpCmd} | gzip > "${dumpFile}"`],
      { timeout: 600_000 },
    );

    await verifyArchive(dumpFile, "dump");

    const checksum = await checksumFile(dumpFile);
    logFn(`Checksum: sha256:${checksum.slice(0, 16)}...`);

    logFn(`Uploading to ${storageKey}`);
    const { sizeBytes } = await storage.upload(storageKey, dumpFile);

    logFn(`Upload complete (${sizeBytes} bytes)`);
    return { sizeBytes, checksum };
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Resolve the Docker volume name for a tar backup (blue/green slot pattern).
 * Returns null if neither slot exists.
 */
async function resolveDockerVolume(
  appName: string,
  volumeName: string,
  logFn: (msg: string) => void,
): Promise<string | null> {
  assertSafeName(appName);
  assertSafeName(volumeName);
  const blueVolume = `${appName}-blue_${volumeName}`;
  const greenVolume = `${appName}-green_${volumeName}`;

  try {
    await execFileAsync("docker", ["volume", "inspect", blueVolume], { timeout: 10_000 });
    return blueVolume;
  } catch {
    try {
      await execFileAsync("docker", ["volume", "inspect", greenVolume], { timeout: 10_000 });
      return greenVolume;
    } catch {
      logFn(`No Docker volume found for ${volumeName} (tried ${blueVolume}, ${greenVolume})`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a full backup run for a given job.
 * Collects volumes from linked apps AND directly linked volumes,
 * then dispatches each by its backup strategy.
 */
export async function runBackup(jobId: string): Promise<BackupResult[]> {
  const job = await db.query.backupJobs.findFirst({
    where: eq(backupJobs.id, jobId),
    with: {
      target: true,
      backupJobApps: {
        with: {
          app: {
            with: {
              organization: {
                columns: { slug: true },
              },
            },
          },
        },
      },
      backupJobVolumes: {
        with: {
          volume: true,
        },
      },
    },
  });

  if (!job) {
    throw new Error(`Backup job not found: ${jobId}`);
  }

  const { executeHooks } = await import("@/lib/hooks/execute");
  const hookResult = await executeHooks("before.backup.run", {
    jobId,
    organizationId: job.organizationId,
    apps: job.backupJobApps.map((bja) => ({ id: bja.app.id, name: bja.app.name })),
  }, { organizationId: job.organizationId ?? undefined });

  if (!hookResult.allowed) {
    throw new Error(`Backup blocked by hook: ${hookResult.blockedBy?.hookName}`);
  }

  const storage = createBackupStorage(job.target);
  const ts = timestamp();
  await ensureDir(BACKUPS_DIR);

  // Collect all volumes to back up
  const volumesToBackup: VolumeToBackup[] = [];

  // From linked apps: find their persistent volumes
  for (const bja of job.backupJobApps) {
    const app = bja.app;
    const orgSlug = app.organization.slug;

    const appVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, app.id),
    });
    const persistentVols = appVolumes.filter((v) => v.persistent);

    for (const vol of persistentVols) {
      volumesToBackup.push({
        id: vol.id,
        name: vol.name,
        appId: app.id,
        appName: app.name,
        orgSlug,
        backupStrategy: vol.backupStrategy,
        backupMeta: vol.backupMeta,
      });
    }
  }

  // From directly linked volumes (system volumes, etc.)
  for (const bjv of job.backupJobVolumes) {
    const vol = bjv.volume;
    volumesToBackup.push({
      id: vol.id,
      name: vol.name,
      appId: vol.appId,
      appName: null,
      orgSlug: null,
      backupStrategy: vol.backupStrategy,
      backupMeta: vol.backupMeta,
    });
  }

  if (volumesToBackup.length === 0) {
    return [];
  }

  // Back up each volume
  const results: BackupResult[] = [];

  for (const vol of volumesToBackup) {
    const backupId = nanoid();
    const startedAt = new Date();
    const logLines: string[] = [];
    const log = (msg: string) => {
      logLines.push(`[${new Date().toISOString()}] ${msg}`);
    };

    // Determine storage key based on context
    const ext = vol.backupStrategy === "dump" ? "dump.gz" : "tar.gz";
    const storageKey = vol.appName && vol.orgSlug
      ? `${vol.orgSlug}/${vol.appName}/${vol.name}/${ts}.${ext}`
      : `vardo-system/${vol.name}/${ts}.${ext}`;

    // Create backup record
    await db.insert(backups).values({
      id: backupId,
      jobId: job.id,
      appId: vol.appId,
      targetId: job.target.id,
      status: "running",
      volumeName: vol.name,
      startedAt,
    });

    try {
      log(`Backing up volume ${vol.name} (strategy: ${vol.backupStrategy})`);

      let result: { sizeBytes: number; checksum: string };

      if (vol.backupStrategy === "dump") {
        if (!vol.backupMeta?.dumpCmd) {
          throw new Error(`Dump strategy requires a dumpCmd (volume: ${vol.name})`);
        }
        result = await backupVolumeDump(
          vol.backupMeta.dumpCmd,
          storageKey,
          storage,
          log,
        );
      } else {
        // tar strategy — need to resolve the Docker volume name
        if (!vol.appName) {
          throw new Error(`Tar backup requires an app name (volume: ${vol.name})`);
        }
        const dockerVolumeName = await resolveDockerVolume(vol.appName, vol.name, log);
        if (!dockerVolumeName) {
          throw new Error(`Volume not found: ${vol.name}`);
        }
        result = await backupVolumeTar(dockerVolumeName, storageKey, storage, log);
      }

      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      await db
        .update(backups)
        .set({
          status: "success",
          sizeBytes: result.sizeBytes,
          storagePath: storageKey,
          checksum: `sha256:${result.checksum}`,
          log: logLines.join("\n"),
          finishedAt,
        })
        .where(eq(backups.id, backupId));

      results.push({
        backupId,
        appId: vol.appId || "",
        volumeName: vol.name,
        success: true,
        sizeBytes: result.sizeBytes,
        storagePath: storageKey,
        durationMs,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Backup failed: ${errorMsg}`);
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      await db
        .update(backups)
        .set({
          status: "failed",
          log: logLines.join("\n"),
          finishedAt,
        })
        .where(eq(backups.id, backupId));

      results.push({
        backupId,
        appId: vol.appId || "",
        volumeName: vol.name,
        success: false,
        sizeBytes: 0,
        storagePath: "",
        error: errorMsg,
        durationMs,
      });
    }
  }

  // Update job's last run timestamp
  await db
    .update(backupJobs)
    .set({ updatedAt: new Date() })
    .where(eq(backupJobs.id, jobId));

  // Notifications
  try {
    const hasFailures = results.some((r) => !r.success);
    const allSuccess = results.every((r) => r.success);

    if (job.organizationId && ((hasFailures && job.notifyOnFailure) || (allSuccess && job.notifyOnSuccess))) {
      const { emit } = await import("@/lib/notifications/dispatch");
      const names = job.backupJobApps.map((bja) => bja.app.name).join(", ") || job.name;
      if (hasFailures) {
        const failed = results.filter((r) => !r.success);
        emit(job.organizationId, { type: "backup.failed", title: `Backup failed: ${job.name}`, message: `${failed.length} of ${results.length} backup(s) failed for: ${names}`, jobId: job.id, jobName: job.name, failedCount: failed.length, totalCount: results.length, errors: failed.map((r) => `${r.volumeName}: ${r.error}`).join("; ") });
      } else {
        emit(job.organizationId, { type: "backup.success", title: `Backup successful: ${job.name}`, message: `${results.length} backup(s) completed for: ${names}`, jobId: job.id, jobName: job.name, totalCount: results.length, totalSize: results.reduce((sum, r) => sum + r.sizeBytes, 0) });
      }
    } else if (!job.organizationId) {
      // System-level job — log to console
      const hasFailures = results.some((r) => !r.success);
      if (hasFailures && job.notifyOnFailure) {
        log.error(`${job.name} FAILED — ${results.filter((r) => !r.success).map((r) => `${r.volumeName}: ${r.error}`).join("; ")}`);
      } else if (!hasFailures && job.notifyOnSuccess) {
        log.info(`${job.name} succeeded (${results.reduce((s, r) => s + r.sizeBytes, 0)} bytes)`);
      }
    }
  } catch (err) {
    log.error("Backup notification error:", err);
  }

  // Enforce retention policy — prune old backups
  try {
    await pruneBackups(jobId);
  } catch (err) {
    log.error("Backup retention pruning error:", err);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Retention / Pruning (GFS — Grandfather-Father-Son)
// ---------------------------------------------------------------------------

type RetentionPolicy = {
  keepAll: boolean;
  keepLast: number | null;
  keepHourly: number | null;
  keepDaily: number | null;
  keepWeekly: number | null;
  keepMonthly: number | null;
  keepYearly: number | null;
};

/**
 * Decide which backup IDs to keep based on GFS retention rules.
 * Backups must be sorted newest-first.
 */
function selectKeepers(
  entries: { id: string; finishedAt: Date }[],
  policy: RetentionPolicy,
): Set<string> {
  if (policy.keepAll) {
    return new Set(entries.map((e) => e.id));
  }

  // If no retention rules are set at all, keep everything (safe default)
  const hasAnyRule =
    policy.keepLast != null || policy.keepHourly != null || policy.keepDaily != null ||
    policy.keepWeekly != null || policy.keepMonthly != null || policy.keepYearly != null;
  if (!hasAnyRule) {
    return new Set(entries.map((e) => e.id));
  }

  const keep = new Set<string>();

  // keepLast — most recent N
  if (policy.keepLast != null && policy.keepLast > 0) {
    for (const e of entries.slice(0, policy.keepLast)) {
      keep.add(e.id);
    }
  }

  // GFS buckets: for each bucket type, keep the newest backup per time period,
  // limited to the N most recent periods.
  const bucketDefs: { key: (d: Date) => string; limit: number | null }[] = [
    {
      key: (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`,
      limit: policy.keepHourly,
    },
    {
      key: (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
      limit: policy.keepDaily,
    },
    {
      key: (d) => {
        const day = new Date(d);
        const dow = day.getUTCDay() || 7;
        day.setUTCDate(day.getUTCDate() - dow + 1);
        return `W${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
      },
      limit: policy.keepWeekly,
    },
    {
      key: (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      limit: policy.keepMonthly,
    },
    {
      key: (d) => `${d.getUTCFullYear()}`,
      limit: policy.keepYearly,
    },
  ];

  for (const { key, limit } of bucketDefs) {
    if (limit == null || limit <= 0) continue;

    // Collect the newest entry per bucket (entries are sorted newest-first)
    const bucketRepresentatives = new Map<string, string>(); // bucketKey → backupId
    for (const e of entries) {
      const k = key(e.finishedAt);
      if (!bucketRepresentatives.has(k)) {
        bucketRepresentatives.set(k, e.id);
      }
    }

    // Keep only the N most recent buckets (Map preserves insertion order = newest first)
    let kept = 0;
    for (const [, backupId] of bucketRepresentatives) {
      if (kept >= limit) break;
      keep.add(backupId);
      kept++;
    }
  }

  return keep;
}

/**
 * Prune backups for a job according to its retention policy.
 * Deletes from storage and marks DB rows as "pruned".
 */
export async function pruneBackups(jobId: string): Promise<number> {
  const job = await db.query.backupJobs.findFirst({
    where: eq(backupJobs.id, jobId),
    with: { target: true },
  });

  if (!job) return 0;

  const policy: RetentionPolicy = {
    keepAll: job.keepAll ?? false,
    keepLast: job.keepLast,
    keepHourly: job.keepHourly,
    keepDaily: job.keepDaily,
    keepWeekly: job.keepWeekly,
    keepMonthly: job.keepMonthly,
    keepYearly: job.keepYearly,
  };

  // Only prune successful backups that are finished
  const allBackups = await db.query.backups.findMany({
    where: and(eq(backups.jobId, jobId), eq(backups.status, "success")),
    orderBy: [desc(backups.finishedAt)],
  });

  // Filter to entries with valid finishedAt
  const eligible = allBackups.filter(
    (b): b is typeof b & { finishedAt: Date } => b.finishedAt !== null,
  );

  if (eligible.length === 0) return 0;

  const keepers = selectKeepers(eligible, policy);
  const toPrune = eligible.filter((b) => !keepers.has(b.id));

  if (toPrune.length === 0) return 0;

  // Delete from storage, then mark as pruned
  const storage = createBackupStorage(job.target);

  for (const backup of toPrune) {
    if (backup.storagePath) {
      try {
        await storage.delete(backup.storagePath);
      } catch (err) {
        log.warn(`Failed to delete ${backup.storagePath} from storage: ${err}`);
        // Continue pruning other backups
      }
    }
  }

  // Bulk-update status to "pruned"
  const pruneIds = toPrune.map((b) => b.id);
  await db
    .update(backups)
    .set({ status: "pruned" })
    .where(inArray(backups.id, pruneIds));

  log.info(`Pruned ${pruneIds.length} backup(s) for job ${job.name}`);
  return pruneIds.length;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Restore a backup — dispatches by the volume's backup strategy.
 * For tar: repopulates the Docker volume.
 * For pg_dump: pipes the dump into psql.
 */
export async function restoreBackup(
  backupId: string,
): Promise<{ success: boolean; log: string }> {
  const backup = await db.query.backups.findFirst({
    where: eq(backups.id, backupId),
    with: {
      target: true,
      app: true,
    },
  });

  if (!backup) {
    throw new Error(`Backup not found: ${backupId}`);
  }

  if (!backup.storagePath) {
    throw new Error("Backup has no storage path");
  }

  if (!backup.volumeName) {
    throw new Error("Backup has no volume name");
  }

  // Look up the volume to determine its backup strategy
  const vol = backup.appId
    ? await db.query.volumes.findFirst({
        where: and(eq(volumes.appId, backup.appId), eq(volumes.name, backup.volumeName)),
      })
    : await db.query.volumes.findFirst({
        where: and(isNull(volumes.appId), eq(volumes.name, backup.volumeName)),
      });

  const strategy = vol?.backupStrategy || "tar";

  const { executeHooks } = await import("@/lib/hooks/execute");
  const restoreHookResult = await executeHooks("before.backup.restore", {
    backupId,
    appId: backup.appId,
    volumeName: backup.volumeName,
  }, { organizationId: backup.target.organizationId ?? undefined });

  if (!restoreHookResult.allowed) {
    throw new Error(`Restore blocked by hook: ${restoreHookResult.blockedBy?.hookName}`);
  }

  const storage = createBackupStorage(backup.target);
  const logLines: string[] = [];
  const log = (msg: string) => {
    logLines.push(`[${new Date().toISOString()}] ${msg}`);
  };

  const tmpDir = join(BACKUPS_DIR, `.tmp-restore-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const archivePath = join(tmpDir, strategy === "dump" ? "dump.gz" : "volume.tar.gz");

  try {
    // 1. Download archive from storage
    log(`Downloading backup from ${backup.storagePath}`);
    await storage.download(backup.storagePath, archivePath);
    log("Download complete");

    // 2. Validate archive integrity
    await verifyArchive(archivePath, "Downloaded backup");
    if (backup.checksum) {
      const downloadChecksum = `sha256:${await checksumFile(archivePath)}`;
      if (downloadChecksum !== backup.checksum) {
        throw new Error(
          `Checksum mismatch — expected ${backup.checksum}, got ${downloadChecksum}. Archive may be corrupt.`
        );
      }
      log("Checksum verified");
    }

    // 3. Restore by strategy
    if (strategy === "dump") {
      if (!vol?.backupMeta?.restoreCmd) {
        throw new Error("Dump restore requires a restoreCmd on the volume");
      }
      // restoreCmd receives the dump via stdin (e.g. "docker exec -i pg psql -U user db")
      log(`Restoring via: ${vol.backupMeta.restoreCmd}`);
      await execFileAsync(
        "bash",
        ["-c", `set -o pipefail; gunzip -c "${archivePath}" | ${vol.backupMeta.restoreCmd}`],
        { timeout: 600_000 },
      );
    } else {
      // tar restore — need app context for volume name resolution
      if (!backup.app) {
        throw new Error("Tar restore requires an app context");
      }
      assertSafeName(backup.app.name);
      assertSafeName(backup.volumeName);
      const blueVolume = `${backup.app.name}-blue_${backup.volumeName}`;
      const greenVolume = `${backup.app.name}-green_${backup.volumeName}`;

      let dockerVolumeName: string;
      try {
        await execFileAsync("docker", ["volume", "inspect", blueVolume], { timeout: 10_000 });
        dockerVolumeName = blueVolume;
      } catch {
        try {
          await execFileAsync("docker", ["volume", "inspect", greenVolume], { timeout: 10_000 });
          dockerVolumeName = greenVolume;
        } catch {
          log(`Creating volume ${blueVolume}`);
          await execFileAsync("docker", ["volume", "create", blueVolume], { timeout: 10_000 });
          dockerVolumeName = blueVolume;
        }
      }

      log(`Restoring to volume ${dockerVolumeName}`);
      await execFileAsync(
        "docker",
        ["run", "--rm", "-v", `${dockerVolumeName}:/data`, "-v", `${tmpDir}:/backup`, "alpine", "sh", "-c", "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/volume.tar.gz -C /data"],
        { timeout: 600_000 },
      );
    }

    log("Restore complete");
    return { success: true, log: logLines.join("\n") };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Restore failed: ${errorMsg}`);
    return { success: false, log: logLines.join("\n") };
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

/**
 * Generate a pre-signed download URL for a backup archive.
 * Returns null if the storage backend doesn't support direct URLs
 * (e.g. SSH targets), in which case the caller should stream through the server.
 */
export async function getBackupDownloadUrl(
  backupId: string,
): Promise<string | null> {
  const backup = await db.query.backups.findFirst({
    where: eq(backups.id, backupId),
    with: { target: true },
  });

  if (!backup) {
    throw new Error(`Backup not found: ${backupId}`);
  }

  if (!backup.storagePath) {
    throw new Error("Backup has no storage path");
  }

  const storage = createBackupStorage(backup.target);

  if (!storage.getDownloadUrl) {
    return null;
  }

  return storage.getDownloadUrl(backup.storagePath, 3600);
}

/**
 * Download a backup to a local temp file (for SSH targets or server-side streaming).
 * Returns the local path. Caller is responsible for cleanup.
 */
export async function downloadBackupToTemp(
  backupId: string,
): Promise<string> {
  const backup = await db.query.backups.findFirst({
    where: eq(backups.id, backupId),
    with: { target: true },
  });

  if (!backup) throw new Error(`Backup not found: ${backupId}`);
  if (!backup.storagePath) throw new Error("Backup has no storage path");

  const tmpDir = join(BACKUPS_DIR, `.tmp-download-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const destPath = join(tmpDir, "backup.tar.gz");

  const storage = createBackupStorage(backup.target);
  await storage.download(backup.storagePath, destPath);
  return destPath;
}
