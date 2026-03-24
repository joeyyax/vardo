import { db } from "@/lib/db";
import {
  backupJobs,
  backups,
  volumes,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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

const execFileAsync = promisify(execFile);

const BACKUPS_DIR = resolve(process.env.VARDO_BACKUPS_DIR || "./.host/backups");
const PG_CONTAINER = process.env.VARDO_PG_CONTAINER || "vardo-postgres";

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
// Core: backup a single volume
// ---------------------------------------------------------------------------

/**
 * Create a tar.gz of a Docker volume and upload it to the storage target.
 * Returns the storage key and size.
 */
async function backupVolume(
  dockerVolumeName: string,
  storageKey: string,
  storage: BackupStorage,
  logFn: (msg: string) => void,
): Promise<{ sizeBytes: number; checksum: string }> {
  const tmpDir = join(BACKUPS_DIR, `.tmp-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const archiveFile = "volume.tar.gz";

  try {
    // Validate volume name before use
    assertSafeName(dockerVolumeName);

    // Tar the volume contents using a temporary Alpine container
    logFn(`Archiving volume ${dockerVolumeName}`);
    await execFileAsync(
      "docker",
      ["run", "--rm", "-v", `${dockerVolumeName}:/data`, "-v", `${tmpDir}:/backup`, "alpine", "tar", "czf", `/backup/${archiveFile}`, "-C", "/data", "."],
      { timeout: 600_000 }, // 10 minute timeout
    );

    // Verify archive is not empty
    const archivePath = join(tmpDir, archiveFile);
    await verifyArchive(archivePath, `Volume ${dockerVolumeName}`);

    // Checksum before upload
    const checksum = await checksumFile(archivePath);
    logFn(`Checksum: sha256:${checksum.slice(0, 16)}...`);

    // Upload via the storage adapter
    logFn(`Uploading to ${storageKey}`);
    const { sizeBytes } = await storage.upload(storageKey, archivePath);

    logFn(`Upload complete (${sizeBytes} bytes)`);
    return { sizeBytes, checksum };
  } finally {
    // Clean up temp files
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a full backup run for a given job.
 * For each app in the job, backs up every persistent volume.
 */
export async function runBackup(jobId: string): Promise<BackupResult[]> {
  // 1. Load the job with its target and apps
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
    },
  });

  if (!job) {
    throw new Error(`Backup job not found: ${jobId}`);
  }

  const storage = createBackupStorage(job.target);
  const ts = timestamp();
  await ensureDir(BACKUPS_DIR);

  // 2. Back up each app's persistent volumes
  const results: BackupResult[] = [];

  for (const bja of job.backupJobApps) {
    const app = bja.app;
    const orgSlug = app.organization.slug;

    // Query persistent volumes from the volumes table
    const appVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, app.id),
    });
    const persistentVols = appVolumes.filter((v) => v.persistent);

    if (persistentVols.length === 0) {
      // No persistent volumes declared, nothing to back up
      continue;
    }

    for (const vol of persistentVols) {
      const backupId = nanoid();
      const startedAt = new Date();
      const logLines: string[] = [];
      const log = (msg: string) => {
        logLines.push(`[${new Date().toISOString()}] ${msg}`);
      };

      // The actual Docker volume name follows the blue/green slot pattern:
      // {appName}-blue_{volumeName} or {appName}-green_{volumeName}
      // We try blue first (production slot), then green
      assertSafeName(app.name);
      assertSafeName(vol.name);
      const blueVolume = `${app.name}-blue_${vol.name}`;
      const greenVolume = `${app.name}-green_${vol.name}`;

      let dockerVolumeName: string;
      try {
        // Check if blue volume exists
        await execFileAsync("docker", ["volume", "inspect", blueVolume], {
          timeout: 10_000,
        });
        dockerVolumeName = blueVolume;
      } catch {
        try {
          await execFileAsync("docker", ["volume", "inspect", greenVolume], {
            timeout: 10_000,
          });
          dockerVolumeName = greenVolume;
        } catch {
          // Neither exists, skip
          log(`No Docker volume found for ${vol.name} (tried ${blueVolume}, ${greenVolume})`);

          await db.insert(backups).values({
            id: backupId,
            jobId: job.id,
            appId: app.id,
            targetId: job.target.id,
            status: "failed",
            volumeName: vol.name,
            log: logLines.join("\n"),
            startedAt,
            finishedAt: new Date(),
          });

          results.push({
            backupId,
            appId: app.id,
            volumeName: vol.name,
            success: false,
            sizeBytes: 0,
            storagePath: "",
            error: `Volume not found: ${vol.name}`,
            durationMs: Date.now() - startedAt.getTime(),
          });
          continue;
        }
      }

      // Storage path: {orgSlug}/{appName}/{volumeName}/{timestamp}.tar.gz
      const storageKey = `${orgSlug}/${app.name}/${vol.name}/${ts}.tar.gz`;

      // Create backup record as running
      await db.insert(backups).values({
        id: backupId,
        jobId: job.id,
        appId: app.id,
        targetId: job.target.id,
        status: "running",
        volumeName: vol.name,
        startedAt,
      });

      try {
        log(`Backing up volume ${vol.name} (Docker: ${dockerVolumeName})`);
        const { sizeBytes, checksum } = await backupVolume(
          dockerVolumeName,
          storageKey,
          storage,
          log,
        );

        const finishedAt = new Date();
        const durationMs = finishedAt.getTime() - startedAt.getTime();

        await db
          .update(backups)
          .set({
            status: "success",
            sizeBytes,
            storagePath: storageKey,
            checksum: `sha256:${checksum}`,
            log: logLines.join("\n"),
            finishedAt,
          })
          .where(eq(backups.id, backupId));

        results.push({
          backupId,
          appId: app.id,
          volumeName: vol.name,
          success: true,
          sizeBytes,
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
          appId: app.id,
          volumeName: vol.name,
          success: false,
          sizeBytes: 0,
          storagePath: "",
          error: errorMsg,
          durationMs,
        });
      }
    }
  }

  // 3. Update job's last run timestamp
  await db
    .update(backupJobs)
    .set({ updatedAt: new Date() })
    .where(eq(backupJobs.id, jobId));

  try { const hasFailures = results.some((r) => !r.success); const allSuccess = results.every((r) => r.success);
    if (job.organizationId && ((hasFailures && job.notifyOnFailure) || (allSuccess && job.notifyOnSuccess))) {
      const { emit } = await import("@/lib/notifications/dispatch"); const appNames = job.backupJobApps.map((bja) => bja.app.name).join(", ");
      if (hasFailures) { const failed = results.filter((r) => !r.success); emit(job.organizationId, { type: "backup.failed", title: `Backup failed: ${job.name}`, message: `${failed.length} of ${results.length} backup(s) failed for: ${appNames}`, jobId: job.id, jobName: job.name, failedCount: failed.length, totalCount: results.length, errors: failed.map((r) => `${r.volumeName}: ${r.error}`).join("; ") }); }
      else { emit(job.organizationId, { type: "backup.success", title: `Backup successful: ${job.name}`, message: `${results.length} backup(s) completed for: ${appNames}`, jobId: job.id, jobName: job.name, totalCount: results.length, totalSize: results.reduce((sum, r) => sum + r.sizeBytes, 0) }); }
    }
  } catch (err) { console.error("[notifications] Backup notification error:", err); }
  return results;
}

// ---------------------------------------------------------------------------
// System backup: Vardo's own PostgreSQL database
// ---------------------------------------------------------------------------

/**
 * Run a pg_dump of Vardo's database and upload it to the storage target.
 * Used for system backup jobs (isSystem = true).
 */
export async function runSystemBackup(jobId: string): Promise<BackupResult[]> {
  const job = await db.query.backupJobs.findFirst({
    where: eq(backupJobs.id, jobId),
    with: { target: true },
  });

  if (!job) {
    throw new Error(`System backup job not found: ${jobId}`);
  }

  const storage = createBackupStorage(job.target);
  const ts = timestamp();
  await ensureDir(BACKUPS_DIR);

  const backupId = nanoid();
  const startedAt = new Date();
  const logLines: string[] = [];
  const log = (msg: string) => {
    logLines.push(`[${new Date().toISOString()}] ${msg}`);
  };

  const storageKey = `vardo-system/postgres/${ts}.sql.gz`;

  // Create backup record as running
  await db.insert(backups).values({
    id: backupId,
    jobId: job.id,
    appId: null, // system backup — no app
    targetId: job.target.id,
    status: "running",
    volumeName: "postgres",
    startedAt,
  });

  const tmpDir = join(BACKUPS_DIR, `.tmp-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const dumpFile = join(tmpDir, "vardo-db.sql.gz");

  try {
    // Parse DATABASE_URL for credentials (default: host/host)
    const dbUrl = process.env.DATABASE_URL || "";
    const dbMatch = dbUrl.match(/^postgresql:\/\/([A-Za-z0-9_-]+):[^@]+@[^/]+\/([A-Za-z0-9_-]+)/);
    const dbUser = dbMatch?.[1] || "host";
    const dbName = dbMatch?.[2] || "host";

    // Validate all shell-interpolated values are safe identifiers
    assertSafeName(PG_CONTAINER);
    assertSafeName(dbUser);
    assertSafeName(dbName);

    // Run pg_dump inside the postgres container, pipe to gzip on the host
    log(`Running pg_dump on ${PG_CONTAINER}`);
    await execFileAsync(
      "sh",
      ["-c", `set -o pipefail; docker exec ${PG_CONTAINER} pg_dump -U ${dbUser} ${dbName} | gzip > "${dumpFile}"`],
      { timeout: 600_000 }, // 10 min
    );

    // Verify dump is not empty (catches broken pipe, missing container, etc.)
    await verifyArchive(dumpFile, "pg_dump");

    // Checksum before upload
    const checksum = await checksumFile(dumpFile);
    log(`Checksum: sha256:${checksum.slice(0, 16)}...`);

    // Upload via storage adapter
    log(`Uploading to ${storageKey}`);
    const { sizeBytes } = await storage.upload(storageKey, dumpFile);

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    log(`Upload complete (${sizeBytes} bytes, ${durationMs}ms)`);

    await db
      .update(backups)
      .set({
        status: "success",
        sizeBytes,
        storagePath: storageKey,
        checksum: `sha256:${checksum}`,
        log: logLines.join("\n"),
        finishedAt,
      })
      .where(eq(backups.id, backupId));

    const successResults: BackupResult[] = [{
      backupId,
      appId: "",
      volumeName: "postgres",
      success: true,
      sizeBytes,
      storagePath: storageKey,
      durationMs,
    }];

    // System backups have no org channel — log for now
    // TODO: admin notification channel for system-level events
    if (job.notifyOnSuccess) {
      console.log(`[backup] System backup succeeded: ${job.name} (${sizeBytes} bytes)`);
    }

    return successResults;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`System backup failed: ${errorMsg}`);
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

    const failResults: BackupResult[] = [{
      backupId,
      appId: "",
      volumeName: "postgres",
      success: false,
      sizeBytes: 0,
      storagePath: "",
      error: errorMsg,
      durationMs,
    }];

    // System backups have no org channel — log for now
    // TODO: admin notification channel for system-level events
    if (job.notifyOnFailure) {
      console.error(`[backup] System backup FAILED: ${job.name} — ${errorMsg}`);
    }

    return failResults;
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Restore a backup by downloading the archive from storage and repopulating
 * the Docker volume.
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

  const storage = createBackupStorage(backup.target);
  const logLines: string[] = [];
  const log = (msg: string) => {
    logLines.push(`[${new Date().toISOString()}] ${msg}`);
  };

  const tmpDir = join(BACKUPS_DIR, `.tmp-restore-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const archivePath = join(tmpDir, "volume.tar.gz");

  try {
    // 1. Download archive from storage
    log(`Downloading backup from ${backup.storagePath}`);
    await storage.download(backup.storagePath, archivePath);
    log("Download complete");

    // 2. Validate archive integrity before restoring
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

    // 3. Determine the Docker volume name (try blue first, then green)
    if (!backup.app) {
      throw new Error("Cannot restore a system backup via volume restore");
    }
    assertSafeName(backup.app.name);
    assertSafeName(backup.volumeName);
    const blueVolume = `${backup.app.name}-blue_${backup.volumeName}`;
    const greenVolume = `${backup.app.name}-green_${backup.volumeName}`;

    let dockerVolumeName: string;
    try {
      await execFileAsync("docker", ["volume", "inspect", blueVolume], {
        timeout: 10_000,
      });
      dockerVolumeName = blueVolume;
    } catch {
      try {
        await execFileAsync("docker", ["volume", "inspect", greenVolume], {
          timeout: 10_000,
        });
        dockerVolumeName = greenVolume;
      } catch {
        // Create the blue volume if neither exists
        log(`Creating volume ${blueVolume}`);
        await execFileAsync("docker", ["volume", "create", blueVolume], {
          timeout: 10_000,
        });
        dockerVolumeName = blueVolume;
      }
    }

    // 3. Restore: clear and repopulate the volume
    log(`Restoring to volume ${dockerVolumeName}`);
    await execFileAsync(
      "docker",
      ["run", "--rm", "-v", `${dockerVolumeName}:/data`, "-v", `${tmpDir}:/backup`, "alpine", "sh", "-c", "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/volume.tar.gz -C /data"],
      { timeout: 600_000 },
    );
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

  // If the adapter doesn't implement getDownloadUrl, return null
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

/**
 * Restore a system database backup by downloading the sql.gz and piping
 * it into psql inside the postgres container.
 */
export async function restoreSystemBackup(
  backupId: string,
): Promise<{ success: boolean; log: string }> {
  const backup = await db.query.backups.findFirst({
    where: eq(backups.id, backupId),
    with: { target: true },
  });

  if (!backup) throw new Error(`Backup not found: ${backupId}`);
  if (!backup.storagePath) throw new Error("Backup has no storage path");

  const storage = createBackupStorage(backup.target);
  const logLines: string[] = [];
  const log = (msg: string) => {
    logLines.push(`[${new Date().toISOString()}] ${msg}`);
  };

  const tmpDir = join(BACKUPS_DIR, `.tmp-restore-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const archivePath = join(tmpDir, "vardo-db.sql.gz");

  try {
    log(`Downloading backup from ${backup.storagePath}`);
    await storage.download(backup.storagePath, archivePath);
    log("Download complete");

    await verifyArchive(archivePath, "Downloaded system backup");
    if (backup.checksum) {
      const downloadChecksum = `sha256:${await checksumFile(archivePath)}`;
      if (downloadChecksum !== backup.checksum) {
        throw new Error(
          `Checksum mismatch — expected ${backup.checksum}, got ${downloadChecksum}. Archive may be corrupt.`
        );
      }
      log("Checksum verified");
    }

    // Parse DATABASE_URL for credentials
    const dbUrl = process.env.DATABASE_URL || "";
    const dbMatch = dbUrl.match(/^postgresql:\/\/([A-Za-z0-9_-]+):[^@]+@[^/]+\/([A-Za-z0-9_-]+)/);
    const dbUser = dbMatch?.[1] || "host";
    const dbName = dbMatch?.[2] || "host";
    assertSafeName(PG_CONTAINER);
    assertSafeName(dbUser);
    assertSafeName(dbName);

    log(`Restoring to ${PG_CONTAINER} database ${dbName}`);
    await execFileAsync(
      "sh",
      ["-c", `set -o pipefail; gunzip -c "${archivePath}" | docker exec -i ${PG_CONTAINER} psql -U ${dbUser} ${dbName}`],
      { timeout: 600_000 },
    );
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
