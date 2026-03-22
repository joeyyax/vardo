import { db } from "@/lib/db";
import {
  backupJobs,
  backups,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { exec } from "child_process";
import { promisify } from "util";
import { mkdir, rm } from "fs/promises";
import { resolve, join } from "path";
import {
  createStorageClient,
  uploadBackup,
  downloadBackup,
  getDownloadUrl as storageGetDownloadUrl,
  type StorageConfig,
} from "./storage";
import {
  uploadViaSsh,
  downloadViaSsh,
  type SshConfig,
} from "./storage-ssh";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

type TargetConfig = StorageConfig | SshConfig;

function isSshConfig(config: TargetConfig): config is SshConfig {
  return "host" in config && "path" in config && !("bucket" in config);
}

async function uploadToTarget(
  config: TargetConfig,
  key: string,
  filePath: string,
): Promise<{ sizeBytes: number }> {
  if (isSshConfig(config)) {
    return uploadViaSsh(config, key, filePath);
  }
  const client = createStorageClient(config);
  return uploadBackup(client, config, key, filePath);
}

async function downloadFromTarget(
  config: TargetConfig,
  key: string,
  destPath: string,
): Promise<void> {
  if (isSshConfig(config)) {
    return downloadViaSsh(config, key, destPath);
  }
  const client = createStorageClient(config);
  return downloadBackup(client, config, key, destPath);
}

const BACKUPS_DIR = resolve(process.env.HOST_BACKUPS_DIR || "./.host/backups");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupResult = {
  backupId: string;
  projectId: string;
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

// ---------------------------------------------------------------------------
// Core: backup a single volume
// ---------------------------------------------------------------------------

/**
 * Create a tar.gz of a Docker volume and upload it to S3-compatible storage.
 * Returns the storage key and size.
 */
async function backupVolume(
  dockerVolumeName: string,
  storageKey: string,
  config: TargetConfig,
  logFn: (msg: string) => void,
): Promise<{ sizeBytes: number }> {
  const tmpDir = join(BACKUPS_DIR, `.tmp-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const archiveFile = "volume.tar.gz";

  try {
    // Tar the volume contents using a temporary Alpine container
    logFn(`Archiving volume ${dockerVolumeName}`);
    await execAsync(
      `docker run --rm -v ${dockerVolumeName}:/data -v ${tmpDir}:/backup alpine tar czf /backup/${archiveFile} -C /data .`,
      { timeout: 600_000 }, // 10 minute timeout
    );

    // Upload via the appropriate transport
    logFn(`Uploading to ${storageKey}`);
    const { sizeBytes } = await uploadToTarget(
      config,
      storageKey,
      join(tmpDir, archiveFile),
    );

    logFn(`Upload complete (${sizeBytes} bytes)`);
    return { sizeBytes };
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
 * For each project in the job, backs up every persistent volume.
 */
export async function runBackup(jobId: string): Promise<BackupResult[]> {
  // 1. Load the job with its target and projects
  const job = await db.query.backupJobs.findFirst({
    where: eq(backupJobs.id, jobId),
    with: {
      target: true,
      backupJobProjects: {
        with: {
          project: {
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

  const config = job.target.config;
  const ts = timestamp();
  await ensureDir(BACKUPS_DIR);

  // 2. Back up each project's persistent volumes
  const results: BackupResult[] = [];

  for (const bjp of job.backupJobProjects) {
    const project = bjp.project;
    const orgSlug = project.organization.slug;
    const volumes = project.persistentVolumes ?? [];

    if (volumes.length === 0) {
      // No persistent volumes declared, nothing to back up
      continue;
    }

    for (const vol of volumes) {
      const backupId = nanoid();
      const startedAt = new Date();
      const logLines: string[] = [];
      const log = (msg: string) => {
        logLines.push(`[${new Date().toISOString()}] ${msg}`);
      };

      // The actual Docker volume name follows the blue/green slot pattern:
      // {projectName}-blue_{volumeName} or {projectName}-green_{volumeName}
      // We try blue first (production slot), then green
      const blueVolume = `${project.name}-blue_${vol.name}`;
      const greenVolume = `${project.name}-green_${vol.name}`;

      let dockerVolumeName: string;
      try {
        // Check if blue volume exists
        await execAsync(`docker volume inspect ${blueVolume}`, {
          timeout: 10_000,
        });
        dockerVolumeName = blueVolume;
      } catch {
        try {
          await execAsync(`docker volume inspect ${greenVolume}`, {
            timeout: 10_000,
          });
          dockerVolumeName = greenVolume;
        } catch {
          // Neither exists, skip
          log(`No Docker volume found for ${vol.name} (tried ${blueVolume}, ${greenVolume})`);

          await db.insert(backups).values({
            id: backupId,
            jobId: job.id,
            projectId: project.id,
            targetId: job.target.id,
            status: "failed",
            volumeName: vol.name,
            log: logLines.join("\n"),
            startedAt,
            finishedAt: new Date(),
          });

          results.push({
            backupId,
            projectId: project.id,
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

      // Storage path: {orgSlug}/{projectName}/{volumeName}/{timestamp}.tar.gz
      const storageKey = `${orgSlug}/${project.name}/${vol.name}/${ts}.tar.gz`;

      // Create backup record as running
      await db.insert(backups).values({
        id: backupId,
        jobId: job.id,
        projectId: project.id,
        targetId: job.target.id,
        status: "running",
        volumeName: vol.name,
        startedAt,
      });

      try {
        log(`Backing up volume ${vol.name} (Docker: ${dockerVolumeName})`);
        const { sizeBytes } = await backupVolume(
          dockerVolumeName,
          storageKey,
          config,
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
            log: logLines.join("\n"),
            finishedAt,
          })
          .where(eq(backups.id, backupId));

        results.push({
          backupId,
          projectId: project.id,
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
          projectId: project.id,
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

  return results;
}

/**
 * Restore a backup by downloading the archive from S3 and repopulating
 * the Docker volume.
 */
export async function restoreBackup(
  backupId: string,
): Promise<{ success: boolean; log: string }> {
  const backup = await db.query.backups.findFirst({
    where: eq(backups.id, backupId),
    with: {
      target: true,
      project: true,
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

  const config = backup.target.config;
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
    await downloadFromTarget(config, backup.storagePath, archivePath);
    log("Download complete");

    // 2. Determine the Docker volume name (try blue first, then green)
    const blueVolume = `${backup.project.name}-blue_${backup.volumeName}`;
    const greenVolume = `${backup.project.name}-green_${backup.volumeName}`;

    let dockerVolumeName: string;
    try {
      await execAsync(`docker volume inspect ${blueVolume}`, {
        timeout: 10_000,
      });
      dockerVolumeName = blueVolume;
    } catch {
      try {
        await execAsync(`docker volume inspect ${greenVolume}`, {
          timeout: 10_000,
        });
        dockerVolumeName = greenVolume;
      } catch {
        // Create the blue volume if neither exists
        log(`Creating volume ${blueVolume}`);
        await execAsync(`docker volume create ${blueVolume}`, {
          timeout: 10_000,
        });
        dockerVolumeName = blueVolume;
      }
    }

    // 3. Restore: clear and repopulate the volume
    log(`Restoring to volume ${dockerVolumeName}`);
    await execAsync(
      `docker run --rm -v ${dockerVolumeName}:/data -v ${tmpDir}:/backup alpine sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/volume.tar.gz -C /data"`,
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
 * Generate a pre-signed download URL for a backup archive (S3 targets),
 * or return null for SSH targets (must be streamed through the server).
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

  const config = backup.target.config;

  // SSH targets don't support pre-signed URLs
  if (isSshConfig(config)) {
    return null;
  }

  const client = createStorageClient(config);
  return storageGetDownloadUrl(client, config, backup.storagePath, 3600);
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

  await downloadFromTarget(backup.target.config, backup.storagePath, destPath);
  return destPath;
}
