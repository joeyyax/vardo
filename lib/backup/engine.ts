import { db } from "@/lib/db";
import {
  backupJobs,
  backupJobProjects,
  backupTargets,
  backups,
  projects,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { exec } from "child_process";
import { promisify } from "util";
import { mkdir, stat } from "fs/promises";
import { resolve, join } from "path";
import { listContainers, inspectContainer } from "@/lib/docker/client";

const execAsync = promisify(exec);

const BACKUPS_DIR = resolve(process.env.HOST_BACKUPS_DIR || "./.host/backups");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupResult = {
  backupId: string;
  projectId: string;
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

async function getFileSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return 0;
  }
}

/**
 * Detect the database type from a container's image name.
 * Returns the dump command strategy or null if not a database.
 */
function detectDatabaseType(
  image: string
): "postgres" | "mysql" | "mariadb" | null {
  const lower = image.toLowerCase();
  if (lower.includes("postgres") || lower.includes("pgvector")) return "postgres";
  if (lower.includes("mariadb")) return "mariadb";
  if (lower.includes("mysql")) return "mysql";
  return null;
}

// ---------------------------------------------------------------------------
// Core backup execution
// ---------------------------------------------------------------------------

/**
 * Run a backup for a single project within a job.
 * Creates a tar.gz archive of all named volumes and optionally
 * dumps databases if a known database container is detected.
 */
async function backupProject(
  projectId: string,
  projectName: string,
  targetPath: string
): Promise<{ archivePath: string; sizeBytes: number; log: string }> {
  const ts = timestamp();
  const archiveName = `${projectName}-${ts}.tar.gz`;
  const archivePath = join(targetPath, archiveName);
  const logLines: string[] = [];

  const log = (msg: string) => {
    logLines.push(`[${new Date().toISOString()}] ${msg}`);
  };

  log(`Starting backup for project: ${projectName}`);

  // Find project containers
  const containers = await listContainers(projectName);
  if (containers.length === 0) {
    log("No running containers found for project");
  }

  // Create a temp directory for this backup's artifacts
  const tmpDir = join(targetPath, `.tmp-${projectName}-${ts}`);
  await ensureDir(tmpDir);

  try {
    // 1. Dump databases from recognized database containers
    for (const container of containers) {
      const info = await inspectContainer(container.id);
      const dbType = detectDatabaseType(info.image);

      if (dbType) {
        log(`Detected ${dbType} database in container ${container.name}`);
        const dumpFile = join(tmpDir, `${container.name}-dump.sql`);

        try {
          let dumpCmd: string;

          if (dbType === "postgres") {
            // Extract POSTGRES_USER from env, default to "postgres"
            const userEnv = info.env.find((e) => e.startsWith("POSTGRES_USER="));
            const pgUser = userEnv ? userEnv.split("=")[1] : "postgres";
            dumpCmd = `docker exec ${container.id} pg_dumpall -U ${pgUser}`;
          } else {
            // mysql/mariadb
            const rootPwEnv = info.env.find(
              (e) =>
                e.startsWith("MYSQL_ROOT_PASSWORD=") ||
                e.startsWith("MARIADB_ROOT_PASSWORD=")
            );
            const rootPw = rootPwEnv ? rootPwEnv.split("=")[1] : "";
            dumpCmd = `docker exec ${container.id} mysqldump --all-databases -u root ${rootPw ? `-p${rootPw}` : ""}`;
          }

          const { stdout } = await execAsync(dumpCmd, {
            maxBuffer: 512 * 1024 * 1024, // 512MB
          });

          const { writeFile } = await import("fs/promises");
          await writeFile(dumpFile, stdout);
          log(`Database dump complete: ${container.name}`);
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : String(err);
          log(`Database dump failed for ${container.name}: ${msg}`);
        }
      }
    }

    // 2. Backup named Docker volumes associated with the project
    // Find volumes by inspecting container mounts
    const volumeNames = new Set<string>();
    for (const container of containers) {
      const info = await inspectContainer(container.id);
      for (const mount of info.mounts) {
        if (mount.type === "volume") {
          // Extract volume name from source path
          const parts = mount.source.split("/");
          const volName = parts[parts.length - 1];
          volumeNames.add(volName);
        }
      }
    }

    if (volumeNames.size > 0) {
      log(`Found ${volumeNames.size} volume(s) to backup`);

      for (const volName of volumeNames) {
        const volArchive = join(tmpDir, `volume-${volName}.tar.gz`);
        try {
          await execAsync(
            `docker run --rm -v ${volName}:/data -v ${tmpDir}:/backup alpine tar czf /backup/volume-${volName}.tar.gz -C /data .`,
            { timeout: 300000 } // 5 minute timeout per volume
          );
          log(`Volume backed up: ${volName}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Volume backup failed for ${volName}: ${msg}`);
        }
      }
    } else {
      log("No Docker volumes found for project");
    }

    // 3. Create final archive from all artifacts in tmpDir
    await execAsync(`tar czf "${archivePath}" -C "${tmpDir}" .`, {
      timeout: 300000,
    });
    log("Final archive created");

    const sizeBytes = await getFileSize(archivePath);
    log(`Archive size: ${sizeBytes} bytes`);

    return { archivePath, sizeBytes, log: logLines.join("\n") };
  } finally {
    // Clean up temp directory
    try {
      await execAsync(`rm -rf "${tmpDir}"`);
    } catch {
      // best effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a full backup run for a given job.
 * Backs up all projects associated with the job.
 */
export async function runBackup(jobId: string): Promise<BackupResult[]> {
  // 1. Load the job with its target and projects
  const job = await db.query.backupJobs.findFirst({
    where: eq(backupJobs.id, jobId),
    with: {
      target: true,
      backupJobProjects: {
        with: { project: true },
      },
    },
  });

  if (!job) {
    throw new Error(`Backup job not found: ${jobId}`);
  }

  // 2. Resolve target path
  let targetPath: string;
  if (job.target.type === "local") {
    const config = job.target.config as { path: string };
    targetPath = resolve(config.path || BACKUPS_DIR);
  } else {
    // For now, only local targets are supported
    throw new Error(`Unsupported backup target type: ${job.target.type}`);
  }

  await ensureDir(targetPath);

  // 3. Back up each project
  const results: BackupResult[] = [];

  for (const bjp of job.backupJobProjects) {
    const project = bjp.project;
    const backupId = nanoid();
    const startedAt = new Date();

    // Create history record
    await db.insert(backups).values({
      id: backupId,
      jobId: job.id,
      projectId: project.id,
      targetId: job.target.id,
      status: "running",
      startedAt,
    });

    try {
      const { archivePath, sizeBytes, log } = await backupProject(
        project.id,
        project.name,
        targetPath
      );

      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      // Update history with success
      await db
        .update(backups)
        .set({
          status: "success",
          sizeBytes,
          storagePath: archivePath,
          log,
          finishedAt,
        })
        .where(eq(backups.id, backupId));

      results.push({
        backupId,
        projectId: project.id,
        success: true,
        sizeBytes,
        storagePath: archivePath,
        durationMs,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      await db
        .update(backups)
        .set({
          status: "failed",
          log: errorMsg,
          finishedAt,
        })
        .where(eq(backups.id, backupId));

      results.push({
        backupId,
        projectId: project.id,
        success: false,
        sizeBytes: 0,
        storagePath: "",
        error: errorMsg,
        durationMs,
      });
    }
  }

  // 4. Update job's last run
  await db
    .update(backupJobs)
    .set({ updatedAt: new Date() })
    .where(eq(backupJobs.id, jobId));

  return results;
}

/**
 * Get the size of a backup file.
 */
export async function getBackupSize(path: string): Promise<number> {
  return getFileSize(path);
}

/**
 * Restore from a backup (stub for future implementation).
 */
export async function restoreBackup(
  _historyId: string
): Promise<{ success: boolean; message: string }> {
  return {
    success: false,
    message:
      "Restore is not yet implemented. Manual restore: extract the backup archive and use docker volume create + docker run to repopulate volumes.",
  };
}
