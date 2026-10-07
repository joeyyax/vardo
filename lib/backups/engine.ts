import { db } from "@/lib/db";
import {
  backupJobs,
  backups,
  volumes,
} from "@/lib/db/schema";
import { eq, and, isNull, isNotNull, desc, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { spawn } from "child_process";
import { pipeline } from "stream/promises";
import { createGzip, createGunzip } from "zlib";
import { mkdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { resolve, join } from "path";
import { ArchiveMissingError, type BackupStorage } from "./storage-port";
import {
  decryptArchiveFile,
  encryptArchiveFile,
  isEncryptedArchiveFile,
  type ArchiveKey,
} from "./archive-crypto";
import { createBackupStorage } from "./storage-factory";
import { assertSafeName } from "@/lib/docker/validate";
import { isUncapturedSource, pausedDumpReason, uncapturedReason } from "./coverage";
import { exclusionReason, isBackupSelected } from "./durability";
import { checkRestoreKey, holdsInstanceSecrets } from "./key-guard";
import { runningKeyFingerprint } from "@/lib/crypto/encrypt";
import { assertSafeBindSource } from "@/lib/docker/mount-paths";
import { buildDumpArgv, buildRestoreArgv, describeDumpSpec, type DumpSpec } from "./dump-spec";
import { resolveDbContainer } from "./resolve-db-container";
import { quiesce, type RestoreDestination } from "./quiesce";
import { getSystemBackupsDefault, resolveBackupSwitch } from "./switch";
import { isSelfApp } from "@/lib/docker/self-env";
import {
  ARCHIVE_HAS_FILES_MARKER,
  DIRECTORY_SOURCE_MARKER,
  EMPTY_SOURCE_MARKER,
  EXCLUDE_LIST_FILE,
  FILE_PAYLOAD_NAME,
  FILE_SOURCE_MARKER,
  MIN_VALID_GZIP_BYTES,
  PROTECT_LIST_FILE,
  buildBindPreflightScript,
  buildFileBackupScript,
  buildFileRestoreScript,
  buildTarBackupScript,
  buildTarRestoreScript,
} from "./archive";
import {
  assertExcludedPath,
  buildFindExclusionArgv,
  parseExcludedPaths,
  protectListBody,
} from "./exclusions";
import { listContainers, inspectContainer } from "@/lib/docker/client";
import { resolveDefaultEnv } from "@/lib/docker/resolve-env";
import { logger } from "@/lib/logger";
import type { BusEvent } from "@/lib/bus/events";
import { execFileAsync } from "@/lib/utils/exec";

const log = logger.child("backup");

// Staging dir for archives. Must be host-visible: it's bind-mounted into a `docker run` container.
const BACKUPS_DIR = resolve(
  process.env.VARDO_BACKUPS_DIR ||
    (process.env.VARDO_HOME_DIR
      ? join(process.env.VARDO_HOME_DIR, "backups-staging")
      : "./.host/backups"),
);

/** skipped — the source is real but the engine cannot capture it (bind mount). */
export type BackupOutcome = "success" | "failed" | "skipped";

/** Archive format. Fixed when the archive is written; restore must not re-derive it. */
export type ArchiveStrategy = "tar" | "dump";

export const APP_DELETED_RESTORE_ERROR =
  "The app this backup belongs to was deleted. Download the archive instead.";

/** A backup row still `running` after this long is abandoned, not in flight. */
export const STALE_RUN_MS = 60 * 60 * 1000;

export type BackupResult = {
  backupId: string;
  appId: string;
  volumeName: string;
  outcome: BackupOutcome;
  sizeBytes: number;
  storagePath: string;
  error?: string;
  /** Skipped because the app is stopped, not because anything went wrong. */
  paused?: boolean;
  /** Skipped because the bind source is empty and has never held data. */
  emptySource?: boolean;
  durationMs: number;
};

/**
 * Whether a run captured every source it covers. Skips count against it, except
 * an empty bind source that never held data.
 */
export function runSucceeded(results: BackupResult[]): boolean {
  return results.length > 0 && results.every((r) => r.emptySource || r.outcome === "success");
}

export type RunBackupOptions = {
  /** Restrict the run to these apps. Other apps on the job are left alone. */
  appIds?: string[];
};

type VolumeToBackup = {
  id: string;
  name: string;
  mountPath: string | null;
  appId: string | null;
  appName: string | null;
  /** apps.status for the owning app. Null for a directly linked volume. */
  appStatus: string | null;
  /** Owning org, so an instance-level job reports progress to each app's org. */
  orgId: string | null;
  orgSlug: string | null;
  type: "named" | "bind";
  source: string | null;
  backupStrategy: string;
  backupMeta: { dumpCmd: string; restoreCmd: string } | null;
  backupSpec: DumpSpec | null;
  durability: string | null;
  /** Paths the archive leaves out. Read live, then recorded on the backup row. */
  backupExcludePatterns: string[] | null;
  backupSelection: "include" | "exclude" | null;
};

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

/** Archive format encoded in the storage key. */
export function strategyFromStoragePath(storagePath: string): ArchiveStrategy | null {
  if (storagePath.endsWith(".dump.gz")) return "dump";
  if (storagePath.endsWith(".tar.gz")) return "tar";
  return null;
}

/**
 * Verify a gzipped archive passes `gzip -t` and holds an entry unless the source was confirmed empty.
 * Pass `sourceWasEmpty` only on evidence from the source: an empty volume and a broken pipe look alike.
 */
async function verifyArchive(
  filePath: string,
  label: string,
  sourceWasEmpty = false,
): Promise<number> {
  const info = await stat(filePath);

  try {
    await execFileAsync("gzip", ["-t", filePath], { timeout: 300_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} archive is corrupt (gzip -t failed): ${msg}`);
  }

  if (!sourceWasEmpty && info.size < MIN_VALID_GZIP_BYTES) {
    throw new Error(
      `${label} produced a ${info.size}-byte file — too small to be valid, backup aborted`
    );
  }

  return info.size;
}

/** Encrypt a verified archive and upload it. Plaintext only when no master key is configured. */
async function uploadArchive(
  archivePath: string,
  storageKey: string,
  storage: BackupStorage,
  logFn: (msg: string) => void,
): Promise<{ sizeBytes: number; archiveKey: ArchiveKey | null }> {
  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  let uploadPath = archivePath;
  let archiveKey: ArchiveKey | null = null;
  if (masterKey) {
    uploadPath = `${archivePath}.enc`;
    archiveKey = await encryptArchiveFile(archivePath, uploadPath, masterKey);
    logFn(`Encrypted under master key ${archiveKey.keyFingerprint}`);
  } else {
    logFn("WARNING: ENCRYPTION_MASTER_KEY is not set — uploading the archive unencrypted");
  }

  logFn(`Uploading to ${storageKey}`);
  const { sizeBytes } = await storage.upload(storageKey, uploadPath);
  logFn(`Upload complete (${sizeBytes} bytes)`);
  return { sizeBytes, archiveKey };
}

/** Download an archive into `destPath`, decrypted. Plaintext passes through unless the row says encrypted. */
async function fetchArchive(
  storage: BackupStorage,
  backup: { storagePath: string; archiveKey: string | null },
  destPath: string,
  logFn: (msg: string) => void = () => {},
): Promise<{ encrypted: boolean }> {
  const sealedPath = `${destPath}.download`;
  try {
    await storage.download(backup.storagePath, sealedPath);

    if (!backup.archiveKey && !(await isEncryptedArchiveFile(sealedPath))) {
      await rename(sealedPath, destPath);
      logFn("Archive is unencrypted");
      return { encrypted: false };
    }

    await decryptArchiveFile(sealedPath, destPath, process.env.ENCRYPTION_MASTER_KEY, {
      requireEncrypted: !!backup.archiveKey,
    });
    logFn("Archive decrypted and authenticated");
    return { encrypted: true };
  } finally {
    await rm(sealedPath, { force: true }).catch(() => {});
  }
}

/**
 * Run the tar backup script in a one-shot container and read back what it left out.
 * Exclusion patterns go in as argv, never script text: they're operator input.
 */
async function runTarBackup(
  mountArgs: string[],
  tmpDir: string,
  excludePatterns: string[],
  timeoutMs: number,
  label: string,
): Promise<{ stdout: string; excludedPaths: string[] }> {
  const findArgv = buildFindExclusionArgv(excludePatterns);

  const { stdout } = await execFileAsync(
    "docker",
    [
      "run", "--rm",
      ...mountArgs,
      "-v", `${tmpDir}:/backup`,
      "alpine", "sh", "-c", buildTarBackupScript(),
      "vardo-backup", ...findArgv,
    ],
    { timeout: timeoutMs },
  );

  const out = String(stdout);
  if (findArgv.length === 0) return { stdout: out, excludedPaths: [] };

  // A pattern that matched every file still leaves a tree that clears the size floor.
  if (!out.includes(ARCHIVE_HAS_FILES_MARKER) && !out.includes(EMPTY_SOURCE_MARKER)) {
    throw new Error(
      `${label} excluded every file — refusing to record an archive that holds none`,
    );
  }

  return {
    stdout: out,
    excludedPaths: parseExcludedPaths(await readFile(join(tmpDir, EXCLUDE_LIST_FILE), "utf8")),
  };
}

/** Create a tar.gz of a Docker volume. */
async function backupVolumeTar(
  dockerVolumeName: string,
  storageKey: string,
  storage: BackupStorage,
  logFn: (msg: string) => void,
  excludePatterns: string[] = [],
): Promise<{ sizeBytes: number; checksum: string; excludedPaths: string[]; archiveKey: ArchiveKey | null }> {
  const tmpDir = join(BACKUPS_DIR, `.tmp-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const archiveFile = "volume.tar.gz";

  try {
    assertSafeName(dockerVolumeName);

    logFn(`Archiving volume ${dockerVolumeName}`);
    const { stdout, excludedPaths } = await runTarBackup(
      ["-v", `${dockerVolumeName}:/data`],
      tmpDir,
      excludePatterns,
      600_000,
      `Volume ${dockerVolumeName}`,
    );
    if (excludePatterns.length > 0) {
      logFn(`Excluded ${excludedPaths.length} path(s) from ${excludePatterns.length} pattern(s)`);
    }

    // The container's own verdict on the source.
    const sourceWasEmpty = stdout.includes(EMPTY_SOURCE_MARKER);
    if (sourceWasEmpty) {
      logFn(`Volume ${dockerVolumeName} is empty — archived 0 files`);
    }

    const archivePath = join(tmpDir, archiveFile);
    await verifyArchive(archivePath, `Volume ${dockerVolumeName}`, sourceWasEmpty);

    const checksum = await checksumFile(archivePath);
    logFn(`Checksum: sha256:${checksum.slice(0, 16)}...`);

    const { sizeBytes, archiveKey } = await uploadArchive(archivePath, storageKey, storage, logFn);
    return { sizeBytes, checksum, excludedPaths, archiveKey };
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/** Write a dump to stdout and gzip it. `run` receives the destination and issues the command. */
async function backupVolumeDump(
  run: (dumpFile: string, logFn: (msg: string) => void) => Promise<void>,
  storageKey: string,
  storage: BackupStorage,
  logFn: (msg: string) => void,
): Promise<{ sizeBytes: number; checksum: string; archiveKey: ArchiveKey | null }> {
  const tmpDir = join(BACKUPS_DIR, `.tmp-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const dumpFile = join(tmpDir, "dump.gz");

  try {
    await run(dumpFile, logFn);

    await verifyArchive(dumpFile, "dump");

    const checksum = await checksumFile(dumpFile);
    logFn(`Checksum: sha256:${checksum.slice(0, 16)}...`);

    const { sizeBytes, archiveKey } = await uploadArchive(dumpFile, storageKey, storage, logFn);
    return { sizeBytes, checksum, archiveKey };
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Stream a dump from `docker` into a gzip file, without a shell.
 * Both the exit code and the pipeline must succeed, or a failed pg_dump's partial output gets stored.
 */
async function streamDockerDump(
  argv: string[],
  dumpFile: string,
  logFn: (msg: string) => void,
): Promise<void> {
  logFn(`Running: docker ${argv.slice(0, 3).join(" ")} …`);
  const child = spawn("docker", argv, { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 8000) stderr += String(chunk);
  });

  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("close", (code) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`dump exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });

  await Promise.all([
    pipeline(child.stdout, createGzip(), createWriteStream(dumpFile)),
    exited,
  ]);

  if (stderr.trim()) logFn(`dump stderr: ${stderr.trim().slice(0, 300)}`);
}

/** Feed a gzipped dump into a container's stdin. Same both-must-succeed rule. */
async function streamDockerRestore(
  argv: string[],
  archivePath: string,
  logFn: (msg: string) => void,
): Promise<void> {
  logFn(`Restoring via: docker ${argv.slice(0, 3).join(" ")} …`);
  const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 8000) stderr += String(chunk);
  });

  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("close", (code) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`restore exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });

  await Promise.all([
    pipeline(createReadStream(archivePath), createGunzip(), child.stdin),
    exited,
  ]);

  if (stderr.trim()) logFn(`restore stderr: ${stderr.trim().slice(0, 300)}`);
}

/** What a bind source turned out to be when Docker mounted it. */
export type BindSourceKind = "directory" | "file";

/**
 * Establish what a bind source is, from inside the container.
 * `-v` resolves on the host, so `fs.stat` here would inspect the wrong machine.
 */
async function preflightBindSource(
  safeSource: string,
): Promise<{ kind: BindSourceKind; empty: boolean }> {
  const { stdout } = await execFileAsync(
    "docker",
    ["run", "--rm", "-v", `${safeSource}:/data:ro`, "alpine", "sh", "-c", buildBindPreflightScript()],
    { timeout: 60_000 },
  );
  const out = String(stdout);
  const empty = out.includes(EMPTY_SOURCE_MARKER);

  if (out.includes(DIRECTORY_SOURCE_MARKER)) return { kind: "directory", empty };
  if (out.includes(FILE_SOURCE_MARKER)) return { kind: "file", empty };
  throw new Error(
    `${safeSource} is neither a directory nor a regular file — sockets and devices cannot be archived`,
  );
}

/** A bind source with nothing in it. */
export class EmptyBindSourceError extends Error {
  constructor(source: string) {
    super(`${source} is empty — refusing to record a backup that would restore as nothing`);
    this.name = "EmptyBindSourceError";
  }
}

const EMPTY_BIND_SKIP_REASON = "Bind source is empty, never backed up";

/** True when a bind volume has an archive on record, so it has held data. */
async function bindSourceHeldData(appId: string | null, volumeName: string): Promise<boolean> {
  const prior = await db.query.backups.findFirst({
    where: and(
      appId ? eq(backups.appId, appId) : isNull(backups.appId),
      eq(backups.volumeName, volumeName),
      inArray(backups.status, ["success", "pruned"]),
      isNotNull(backups.resolvedSource),
    ),
    columns: { id: true },
  });
  return prior !== undefined;
}

/** Archive a host path, directory or single file. Mounted `:ro` so a bug can't write to the host. */
async function backupBindTar(
  hostSource: string,
  storageKey: string,
  storage: BackupStorage,
  logFn: (msg: string) => void,
  excludePatterns: string[] = [],
): Promise<{
  sizeBytes: number;
  checksum: string;
  kind: BindSourceKind;
  excludedPaths: string[];
  archiveKey: ArchiveKey | null;
}> {
  const tmpDir = join(BACKUPS_DIR, `.tmp-${nanoid(8)}`);
  await ensureDir(tmpDir);

  try {
    const safeSource = assertSafeBindSource(hostSource, {
      dockerRoot: await dockerDataRoot(),
      label: "bind source",
    });

    const { kind, empty } = await preflightBindSource(safeSource);

    // A typo'd bind source looks like an empty directory. The caller decides.
    if (empty) throw new EmptyBindSourceError(safeSource);

    // A single file has no paths to subtract.
    if (kind === "file" && excludePatterns.length > 0) {
      throw new Error(
        `${safeSource} is a single file — exclusion patterns cannot apply to it, remove them to back it up`,
      );
    }

    logFn(`Archiving host ${kind} ${safeSource}`);

    let excludedPaths: string[] = [];
    if (kind === "file") {
      await execFileAsync(
        "docker",
        [
          "run", "--rm",
          "-v", `${safeSource}:/data/${FILE_PAYLOAD_NAME}:ro`,
          "-v", `${tmpDir}:/backup`,
          "alpine", "sh", "-c", buildFileBackupScript(),
        ],
        { timeout: 1_800_000 },
      );
    } else {
      ({ excludedPaths } = await runTarBackup(
        ["-v", `${safeSource}:/data:ro`],
        tmpDir,
        excludePatterns,
        1_800_000,
        `Bind mount ${safeSource}`,
      ));
      if (excludePatterns.length > 0) {
        logFn(`Excluded ${excludedPaths.length} path(s) from ${excludePatterns.length} pattern(s)`);
      }
    }

    const archivePath = join(tmpDir, "volume.tar.gz");
    await verifyArchive(archivePath, `Bind mount ${safeSource}`);

    const checksum = await checksumFile(archivePath);
    logFn(`Checksum: sha256:${checksum.slice(0, 16)}...`);

    const { sizeBytes, archiveKey } = await uploadArchive(archivePath, storageKey, storage, logFn);
    return { sizeBytes, checksum, kind, excludedPaths, archiveKey };
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/** The daemon's real data root, so the deny-list covers where volumes actually live. */
async function dockerDataRoot(): Promise<string | null> {
  try {
    const { getSystemInfo } = await import("@/lib/docker/client");
    return (await getSystemInfo()).dockerRootDir;
  } catch {
    return null;
  }
}

/**
 * Resolve the Docker volume backing an app's volume: the one mounted in a running container,
 * then the env-scoped `${app}-${env}_${vol}`, then legacy slot names. Null if none resolve.
 */
export async function resolveDockerVolume(
  appId: string | null,
  appName: string,
  volumeName: string,
  mountPath: string | null,
  logFn: (msg: string) => void,
): Promise<string | null> {
  assertSafeName(appName);
  assertSafeName(volumeName);

  // `vardo.environment` separates environments that share `vardo.project`.
  const env = appId ? await resolveDefaultEnv(appId) : null;

  // 1. The volume Docker has mounted at mountPath.
  if (mountPath) {
    try {
      const containers = await listContainers(
        appId ? { id: appId, name: appName } : appName,
        env?.name,
      );
      for (const c of containers) {
        const info = await inspectContainer(c.id);
        const mount = info.mounts.find(
          (m) => m.type === "volume" && m.destination === mountPath && m.name,
        );
        if (mount) {
          logFn(`Resolved ${volumeName} → ${mount.name} (running container mount at ${mountPath})`);
          return mount.name;
        }
      }
    } catch (err) {
      logFn(
        `Container inspect for ${appName} failed, falling back to name derivation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2 + 3. Name-derived candidates, env-scoped first, slot names last.
  const candidates: string[] = [];
  if (env) {
    candidates.push(`${appName}-${env.name}_${volumeName}`);
  }
  candidates.push(`${appName}-blue_${volumeName}`, `${appName}-green_${volumeName}`);

  for (const candidate of candidates) {
    try {
      await execFileAsync("docker", ["volume", "inspect", candidate], { timeout: 10_000 });
      logFn(`Resolved ${volumeName} → ${candidate}`);
      return candidate;
    } catch {
      // not this one
    }
  }

  logFn(`No Docker volume found for ${volumeName} (tried ${candidates.join(", ")})`);
  return null;
}

/** Run a backup job over its linked apps and volumes. Pass `appIds` to run a subset of the apps. */
export async function runBackup(
  jobId: string,
  options: RunBackupOptions = {},
): Promise<BackupResult[]> {
  const job = await db.query.backupJobs.findFirst({
    where: eq(backupJobs.id, jobId),
    with: {
      target: true,
      backupJobApps: {
        with: {
          app: {
            with: {
              organization: {
                columns: { slug: true, backupsEnabled: true },
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

  // Defense in depth against cross-org links. Instance-level jobs span orgs.
  const owned = job.organizationId
    ? job.backupJobApps.filter((bja) => bja.app.organizationId === job.organizationId)
    : job.backupJobApps;

  const scope = options.appIds ? new Set(options.appIds) : null;
  const scoped = scope ? owned.filter((bja) => scope.has(bja.app.id)) : owned;
  // Schedules skip retired apps and apps with backups switched off. A failed settings read backs up.
  const systemDefault = options.appIds ? true : await getSystemBackupsDefault().catch(() => true);
  const switchedOn = options.appIds
    ? scoped
    : scoped.filter(
        (bja) => resolveBackupSwitch(bja.app.backupsEnabled, bja.app.organization?.backupsEnabled, systemDefault).enabled,
      );
  const jobApps = options.appIds
    ? scoped
    : switchedOn.filter((bja) => bja.app.status !== "missing");
  const jobVolumes = scope
    ? job.backupJobVolumes.filter((bjv) => bjv.volume.appId && scope.has(bjv.volume.appId))
    : job.backupJobVolumes;

  const storage = createBackupStorage(job.target);
  const ts = timestamp();
  await ensureDir(BACKUPS_DIR);

  const volumesToBackup: VolumeToBackup[] = [];
  // Sources left out by durability class.
  const excludedSources: { name: string; appName: string | null; reason: string }[] = [];

  for (const bja of jobApps) {
    const app = bja.app;
    const orgSlug = app.organization.slug;

    const appVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, app.id),
    });
    const persistentVols = appVolumes.filter(isBackupSelected);

    for (const vol of persistentVols) {
      // Not covered by the job: no row and no archive.
      const excluded = exclusionReason(vol.durability);
      if (excluded) {
        excludedSources.push({ name: vol.name, appName: app.name, reason: excluded });
        continue;
      }

      volumesToBackup.push({
        id: vol.id,
        name: vol.name,
        mountPath: vol.mountPath,
        appId: app.id,
        appName: app.name,
        appStatus: app.status,
        orgId: app.organizationId,
        orgSlug,
        type: vol.type,
        source: vol.source,
        backupStrategy: vol.backupStrategy,
        backupMeta: vol.backupMeta,
        backupSpec: vol.backupSpec,
        durability: vol.durability,
        backupExcludePatterns: vol.backupExcludePatterns,
        backupSelection: vol.backupSelection,
      });
    }
  }

  for (const bjv of jobVolumes) {
    const vol = bjv.volume;
    const excluded = exclusionReason(vol.durability);
    if (excluded) {
      excludedSources.push({ name: vol.name, appName: null, reason: excluded });
      continue;
    }
    volumesToBackup.push({
      id: vol.id,
      name: vol.name,
      mountPath: vol.mountPath,
      appId: vol.appId,
      appName: null,
      appStatus: null,
      orgId: null,
      orgSlug: null,
      type: vol.type,
      source: vol.source,
      backupStrategy: vol.backupStrategy,
      backupMeta: vol.backupMeta,
      backupSpec: vol.backupSpec,
      durability: vol.durability,
      backupExcludePatterns: vol.backupExcludePatterns,
      backupSelection: vol.backupSelection,
    });
  }

  if (volumesToBackup.length === 0) {
    // Every source was classified out. Refresh lastRunAt or the stale-backup check flags this forever.
    if (excludedSources.length > 0) {
      const finishedRunAt = new Date();
      await db
        .update(backupJobs)
        .set({ lastRunAt: finishedRunAt, updatedAt: finishedRunAt })
        .where(eq(backupJobs.id, jobId));
      log.info(
        `${job.name}: nothing to capture — ${excludedSources.length} source(s) excluded by durability`,
      );
    }
    // A job whose apps were all deleted still holds their history.
    try {
      await pruneBackups(jobId);
    } catch (err) {
      log.error("Backup retention pruning error:", err);
    }
    return [];
  }

  // Live progress for the backups UI. Best effort: a bus fault can't abort a run.
  const totalSources = volumesToBackup.length;
  let emitEvent: ((orgId: string, event: BusEvent) => void) | null = null;
  try {
    ({ emit: emitEvent } = await import("@/lib/notifications/dispatch"));
  } catch (err) {
    log.warn("progress bus unavailable:", err);
  }

  function publishProgress(vol: VolumeToBackup, index: number): void {
    try {
      const progressOrgId = vol.orgId ?? job!.organizationId;
      if (!emitEvent || !progressOrgId) return;
      const appName = vol.appName ?? vol.name;
      emitEvent(progressOrgId, {
        type: "backup.progress",
        title: `Backing up ${appName}`,
        message: `${appName} (${index} of ${totalSources})`,
        jobId: job!.id,
        jobName: job!.name,
        appId: vol.appId,
        appName,
        volumeName: vol.name,
        index,
        total: totalSources,
      });
    } catch (err) {
      log.warn("progress emit failed:", err);
    }
  }

  const results: BackupResult[] = [];
  let sourceIndex = 0;

  for (const vol of volumesToBackup) {
    publishProgress(vol, ++sourceIndex);
    const backupId = nanoid();
    const startedAt = new Date();
    const logLines: string[] = [];
    const log = (msg: string) => {
      logLines.push(`[${new Date().toISOString()}] ${msg}`);
    };

    // Sources the engine can't archive are recorded as skipped, not failed.
    if (isUncapturedSource(vol)) {
      const reason = uncapturedReason(vol);
      log(`Skipping volume ${vol.name}: ${reason}`);
      const finishedAt = new Date();
      await db.insert(backups).values({
        id: backupId,
        jobId: job.id,
        jobName: job.name,
        appId: vol.appId,
        appName: vol.appName,
        organizationId: vol.orgId ?? job.organizationId,
        targetId: job.target.id,
        status: "skipped",
        volumeName: vol.name,
        startedAt,
        finishedAt,
        log: logLines.join("\n"),
      });
      results.push({
        backupId,
        appId: vol.appId || "",
        volumeName: vol.name,
        outcome: "skipped",
        sizeBytes: 0,
        storagePath: "",
        error: reason,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
      continue;
    }

    const strategy: ArchiveStrategy = vol.backupStrategy === "dump" ? "dump" : "tar";
    const ext = strategy === "dump" ? "dump.gz" : "tar.gz";
    const storageKey = vol.appName && vol.orgSlug
      ? `${vol.orgSlug}/${vol.appName}/${vol.name}/${ts}.${ext}`
      : `vardo-system/${vol.name}/${ts}.${ext}`;

    // The key fingerprint is stamped only when the archive carries this instance's ciphertext.
    await db.insert(backups).values({
      id: backupId,
      jobId: job.id,
      jobName: job.name,
      appId: vol.appId,
      appName: vol.appName,
      organizationId: vol.orgId ?? job.organizationId,
      targetId: job.target.id,
      status: "running",
      volumeName: vol.name,
      strategy,
      keyFingerprint: holdsInstanceSecrets(vol) ? runningKeyFingerprint() : null,
      startedAt,
    });

    try {
      log(`Backing up volume ${vol.name} (strategy: ${strategy})`);

      let result: { sizeBytes: number; checksum: string; archiveKey: ArchiveKey | null };
      let resolvedSource: string | null = null;
      let sourceKind: string | null = null;
      let excludedPaths: string[] = [];
      const excludePatterns = vol.backupExcludePatterns ?? [];

      if (strategy === "dump") {
        const spec = vol.backupSpec;
        const legacyCmd = vol.backupMeta?.dumpCmd;
        if (!spec && !legacyCmd) {
          throw new Error(`Dump strategy requires a backupSpec or dumpCmd (volume: ${vol.name})`);
        }

        // Prefer the spec: it resolves its container now.
        const runDump = spec
          ? async (dumpFile: string, logFn: (msg: string) => void) => {
              if (!vol.appId || !vol.appName) {
                throw new Error(`A dump spec needs an app to resolve against (volume: ${vol.name})`);
              }
              logFn(`Dump spec: ${describeDumpSpec(spec)}`);
              const env = await resolveDefaultEnv(vol.appId);
              const container = await resolveDbContainer(
                spec,
                { id: vol.appId, name: vol.appName },
                env?.name,
                logFn,
              );
              if (!container) {
                throw new Error(
                  `No running container for service "${spec.service}" — cannot dump ${vol.name}`,
                );
              }
              await streamDockerDump(buildDumpArgv(spec.kind, container.id, container.env), dumpFile, logFn);
            }
          : async (dumpFile: string, logFn: (msg: string) => void) => {
              logFn(`Running dump: ${legacyCmd}`);
              await execFileAsync(
                "bash",
                ["-c", `set -o pipefail; ${legacyCmd} | gzip > "${dumpFile}"`],
                { timeout: 600_000 },
              );
            };

        result = await backupVolumeDump(
          runDump,
          storageKey,
          storage,
          log,
        );
      } else if (vol.type === "bind") {
        if (!vol.source) {
          throw new Error(`Bind mount ${vol.name} has no host path recorded`);
        }
        const bind = await backupBindTar(vol.source, storageKey, storage, log, excludePatterns);
        result = bind;
        resolvedSource = vol.source;
        sourceKind = bind.kind;
        excludedPaths = bind.excludedPaths;
      } else {
        if (!vol.appName) {
          throw new Error(`Tar backup requires an app name (volume: ${vol.name})`);
        }
        const dockerVolumeName = await resolveDockerVolume(vol.appId, vol.appName, vol.name, vol.mountPath, log);
        if (!dockerVolumeName) {
          throw new Error(`Volume not found: ${vol.name}`);
        }
        const tar = await backupVolumeTar(dockerVolumeName, storageKey, storage, log, excludePatterns);
        result = tar;
        excludedPaths = tar.excludedPaths;
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
          archiveKey: result.archiveKey?.wrappedKey ?? null,
          archiveKeyFingerprint: result.archiveKey?.keyFingerprint ?? null,
          resolvedSource,
          sourceKind,
          excludedPaths: excludedPaths.length > 0 ? excludedPaths : null,
          log: logLines.join("\n"),
          finishedAt,
        })
        .where(eq(backups.id, backupId));

      results.push({
        backupId,
        appId: vol.appId || "",
        volumeName: vol.name,
        outcome: "success",
        sizeBytes: result.sizeBytes,
        storagePath: storageKey,
        durationMs,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Empty and never held data is fine. Once it has held data, empty means the mount went missing.
      if (err instanceof EmptyBindSourceError && !(await bindSourceHeldData(vol.appId, vol.name))) {
        log(`Skipping volume ${vol.name}: ${vol.source} is empty and has never been backed up with data`);
        const finishedAt = new Date();
        await db
          .update(backups)
          .set({ status: "skipped", log: logLines.join("\n"), finishedAt })
          .where(eq(backups.id, backupId));
        results.push({
          backupId,
          appId: vol.appId || "",
          volumeName: vol.name,
          outcome: "skipped",
          sizeBytes: 0,
          storagePath: "",
          error: EMPTY_BIND_SKIP_REASON,
          emptySource: true,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        });
        continue;
      }

      log(`Backup failed: ${errorMsg}`);

      // Classified after the attempt: apps.status is cached and may say stopped while the container is up.
      const paused = pausedDumpReason(vol);
      if (paused) log(paused);

      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      await db
        .update(backups)
        .set({
          status: paused ? "skipped" : "failed",
          log: logLines.join("\n"),
          finishedAt,
        })
        .where(eq(backups.id, backupId));

      results.push({
        backupId,
        appId: vol.appId || "",
        volumeName: vol.name,
        outcome: paused ? "skipped" : "failed",
        sizeBytes: 0,
        storagePath: "",
        error: paused ?? errorMsg,
        paused: paused !== null,
        durationMs,
      });
    }
  }

  // Only a full-job run that captured an archive may refresh lastRunAt.
  const coveredWholeJob =
    jobApps.length === job.backupJobApps.length - (scoped.length - switchedOn.length) &&
    jobVolumes.length === job.backupJobVolumes.length;
  const capturedSomething = results.some((r) => r.outcome === "success");
  const onlyEmptySources = results.length > 0 && results.every((r) => r.emptySource);
  if (coveredWholeJob && (capturedSomething || onlyEmptySources)) {
    const finishedRunAt = new Date();
    await db
      .update(backupJobs)
      .set({ lastRunAt: finishedRunAt, updatedAt: finishedRunAt })
      .where(eq(backupJobs.id, jobId));
  }

  try {
    const succeeded = results.filter((r) => r.outcome === "success");
    const failed = results.filter((r) => r.outcome === "failed");
    const allSkipped = results.filter((r) => r.outcome === "skipped");
    // Empty, never-populated bind sources don't count either way.
    const skipped = allSkipped.filter((r) => !r.emptySource);
    // Capturing nothing is a failure, unless every miss is a dump waiting on a stopped app.
    const capturedNothing = succeeded.length === 0;
    const onlyPaused =
      capturedNothing &&
      failed.length === 0 &&
      allSkipped.length > 0 &&
      skipped.every((r) => r.paused);
    const hasFailures = failed.length > 0 || (capturedNothing && !onlyPaused);
    const allSuccess = !hasFailures;
    const notes = [
      allSkipped.length > 0 ? `${allSkipped.length} skipped` : null,
      excludedSources.length > 0 ? `${excludedSources.length} excluded by durability` : null,
    ].filter(Boolean);
    const skippedNote = notes.length > 0 ? ` (${notes.join(", ")})` : "";

    if (onlyPaused) {
      log.info(`${job.name}: nothing captured — every source is waiting on a stopped app or empty`);
    } else if (job.organizationId && ((hasFailures && job.notifyOnFailure) || (allSuccess && job.notifyOnSuccess))) {
      const { emit } = await import("@/lib/notifications/dispatch");
      const names = jobApps.map((bja) => bja.app.name).join(", ") || job.name;
      if (hasFailures) {
        const problems = [...failed, ...skipped];
        const message = failed.length > 0
          ? `${failed.length} of ${results.length} backup(s) failed for: ${names}${skippedNote}`
          : `Nothing was captured for: ${names}${skippedNote}`;
        emit(job.organizationId, { type: "backup.failed", title: `Backup failed: ${job.name}`, message, jobId: job.id, jobName: job.name, failedCount: problems.length, totalCount: results.length, errors: problems.map((r) => `${r.volumeName}: ${r.error}`).join("; ") });
      } else {
        emit(job.organizationId, { type: "backup.success", title: `Backup successful: ${job.name}`, message: `${succeeded.length} backup(s) completed for: ${names}${skippedNote}`, jobId: job.id, jobName: job.name, totalCount: results.length, totalSize: results.reduce((sum, r) => sum + r.sizeBytes, 0) });
      }
    } else if (!job.organizationId) {
      if (hasFailures && job.notifyOnFailure) {
        log.error(`${job.name} FAILED — ${[...failed, ...skipped].map((r) => `${r.volumeName}: ${r.error}`).join("; ")}`);
      } else if (!hasFailures && job.notifyOnSuccess) {
        log.info(`${job.name} succeeded (${results.reduce((s, r) => s + r.sizeBytes, 0)} bytes)${skippedNote}`);
      }
    }
  } catch (err) {
    log.error("Backup notification error:", err);
  }

  try {
    await pruneBackups(jobId);
  } catch (err) {
    log.error("Backup retention pruning error:", err);
  }

  return results;
}

// Retention (GFS: grandfather-father-son)

type RetentionPolicy = {
  keepAll: boolean;
  keepLast: number | null;
  keepHourly: number | null;
  keepDaily: number | null;
  keepWeekly: number | null;
  keepMonthly: number | null;
  keepYearly: number | null;
};

/** Backup IDs to keep under GFS retention rules. Input must be sorted newest-first. */
function selectKeepers(
  entries: { id: string; finishedAt: Date }[],
  policy: RetentionPolicy,
): Set<string> {
  if (policy.keepAll) {
    return new Set(entries.map((e) => e.id));
  }

  // No retention rules: keep everything.
  const hasAnyRule =
    policy.keepLast != null || policy.keepHourly != null || policy.keepDaily != null ||
    policy.keepWeekly != null || policy.keepMonthly != null || policy.keepYearly != null;
  if (!hasAnyRule) {
    return new Set(entries.map((e) => e.id));
  }

  const keep = new Set<string>();

  if (policy.keepLast != null && policy.keepLast > 0) {
    for (const e of entries.slice(0, policy.keepLast)) {
      keep.add(e.id);
    }
  }

  // Newest backup per period, for the N most recent periods.
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

    const bucketRepresentatives = new Map<string, string>(); // bucketKey → backupId
    for (const e of entries) {
      const k = key(e.finishedAt);
      if (!bucketRepresentatives.has(k)) {
        bucketRepresentatives.set(k, e.id);
      }
    }

    // Map preserves insertion order, newest first.
    let kept = 0;
    for (const [, backupId] of bucketRepresentatives) {
      if (kept >= limit) break;
      keep.add(backupId);
      kept++;
    }
  }

  return keep;
}

/** Apply retention per (app, volume) pair. Entries must be sorted newest-first. */
export function selectKeepersByVolume(
  entries: { id: string; finishedAt: Date; appId: string | null; volumeName: string | null }[],
  policy: RetentionPolicy,
): Set<string> {
  const byVolume = new Map<string, { id: string; finishedAt: Date }[]>();
  for (const e of entries) {
    const key = JSON.stringify([e.appId ?? "", e.volumeName ?? ""]);
    let group = byVolume.get(key);
    if (!group) byVolume.set(key, (group = []));
    group.push(e);
  }

  const keepers = new Set<string>();
  for (const group of byVolume.values()) {
    for (const id of selectKeepers(group, policy)) keepers.add(id);
  }
  return keepers;
}

/** Prune a job's backups by its retention policy: delete from storage, mark rows "pruned". */
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

  const allBackups = await db.query.backups.findMany({
    where: and(eq(backups.jobId, jobId), eq(backups.status, "success")),
    orderBy: [desc(backups.finishedAt)],
  });

  const eligible = allBackups.filter(
    (b): b is typeof b & { finishedAt: Date } => b.finishedAt !== null,
  );

  if (eligible.length === 0) return 0;

  const keepers = selectKeepersByVolume(eligible, policy);
  const toPrune = eligible.filter((b) => !keepers.has(b.id));

  if (toPrune.length === 0) return 0;

  const storage = createBackupStorage(job.target);

  // Mark pruned only rows whose object is really gone.
  const pruneIds: string[] = [];
  let undeleted = 0;

  for (const backup of toPrune) {
    if (backup.storagePath) {
      try {
        await storage.delete(backup.storagePath);
      } catch (err) {
        if (err instanceof ArchiveMissingError) {
          pruneIds.push(backup.id);
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to delete ${backup.storagePath} from storage: ${reason}`);
        undeleted++;
        continue;
      }
    }
    pruneIds.push(backup.id);
  }

  if (pruneIds.length > 0) {
    await db
      .update(backups)
      .set({ status: "pruned", archiveKey: null })
      .where(inArray(backups.id, pruneIds));
  }

  if (undeleted > 0) {
    log.warn(`${undeleted} backup(s) left in storage for job ${job.name} — delete failed, rows kept`);
  }

  log.info(`Pruned ${pruneIds.length} backup(s) for job ${job.name}`);
  return pruneIds.length;
}

/** Where a failed rollback leaves the pre-restore copy. */
async function keepSnapshot(snapshotFile: string, backupId: string, log: (msg: string) => void) {
  const kept = join(BACKUPS_DIR, `pre-restore-${backupId}-${timestamp()}${snapshotFile.endsWith(".tar.gz") ? ".tar.gz" : ".gz"}`);
  try {
    await rename(snapshotFile, kept);
    log(`Pre-restore copy kept at ${kept}`);
  } catch (err) {
    log(`WARNING: could not keep the pre-restore copy — ${err instanceof Error ? err.message : err}`);
  }
}

/** Stop the destination's writers, copy it aside, restore and put the copy back on failure. */
async function restoreFilesWithSnapshot(opts: {
  backupId: string;
  dest: RestoreDestination | null;
  /** `-v` spec for the destination, as the restore script expects it. */
  mount: string;
  snapshotScript: string;
  restoreScript: string;
  tmpDir: string;
  timeoutMs: number;
  log: (msg: string) => void;
}): Promise<void> {
  const { backupId, dest, mount, tmpDir, timeoutMs, log } = opts;
  const snapshotDir = join(tmpDir, "pre-restore");
  await ensureDir(snapshotDir);

  const quiesced = dest ? await quiesce(dest, log) : null;
  try {
    log("Copying the current data aside before restoring");
    await execFileAsync(
      "docker",
      ["run", "--rm", "-v", mount, "-v", `${snapshotDir}:/backup`, "alpine", "sh", "-c", opts.snapshotScript],
      { timeout: timeoutMs },
    );

    try {
      await execFileAsync(
        "docker",
        ["run", "--rm", "-v", mount, "-v", `${tmpDir}:/backup`, "alpine", "sh", "-c", opts.restoreScript],
        { timeout: timeoutMs },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Restore failed (${message}) — putting the previous data back`);
      try {
        await execFileAsync(
          "docker",
          ["run", "--rm", "-v", mount, "-v", `${snapshotDir}:/backup`, "alpine", "sh", "-c", opts.restoreScript],
          { timeout: timeoutMs },
        );
        log("Previous data restored");
      } catch (rollbackErr) {
        log(`WARNING: putting the previous data back failed — ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`);
        await keepSnapshot(join(snapshotDir, "volume.tar.gz"), backupId, log);
      }
      throw err;
    }
  } finally {
    await quiesced?.resume();
  }
}

/** Dump restore for engines without transactions: dump the live database first, replay it on failure. */
async function restoreDumpWithSnapshot(opts: {
  backupId: string;
  kind: DumpSpec["kind"];
  containerId: string;
  containerEnv: string[];
  archivePath: string;
  tmpDir: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { backupId, kind, containerId, containerEnv, archivePath, tmpDir, log } = opts;
  const restoreArgv = buildRestoreArgv(kind, containerId, containerEnv);

  // One transaction: a failure leaves the database as it was.
  if (kind === "postgres") {
    await streamDockerRestore(restoreArgv, archivePath, log);
    return;
  }

  const snapshotFile = join(tmpDir, "pre-restore.dump.gz");
  log("Dumping the current database before restoring");
  await streamDockerDump(buildDumpArgv(kind, containerId, containerEnv), snapshotFile, log);

  try {
    await streamDockerRestore(restoreArgv, archivePath, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Restore failed (${message}) — replaying the pre-restore dump`);
    try {
      await streamDockerRestore(restoreArgv, snapshotFile, log);
      log("Previous database restored");
    } catch (rollbackErr) {
      log(`WARNING: replaying the pre-restore dump failed — ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`);
      await keepSnapshot(snapshotFile, backupId, log);
    }
    throw err;
  }
}

/** Restore a backup by its archive format. */
export async function restoreBackup(
  backupId: string,
  opts: {
    /** Restore an archive from a different master key. Its env vars stay unreadable. */
    acceptKeyMismatch?: boolean;
  } = {},
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

  if (backup.appId && !backup.app) {
    throw new Error(APP_DELETED_RESTORE_ERROR);
  }

  if (!backup.storagePath) {
    throw new Error("Backup has no storage path");
  }

  if (!backup.volumeName) {
    throw new Error("Backup has no volume name");
  }

  // Use the format that was written, not the volume's current config: a wrong guess empties the volume.
  const strategy: ArchiveStrategy | null =
    (backup.strategy as ArchiveStrategy | null) ?? strategyFromStoragePath(backup.storagePath);

  if (strategy !== "tar" && strategy !== "dump") {
    throw new Error(
      `Cannot determine the archive format of backup ${backupId} (storage path: ${backup.storagePath}) — refusing to restore`,
    );
  }

  // Restoring Vardo's own database brings ciphertext the running key may not open.
  const carriesInstanceSecrets = holdsInstanceSecrets({
    appId: backup.appId,
    name: backup.volumeName,
  });
  const keyVerdict = checkRestoreKey({
    archiveFingerprint: backup.keyFingerprint,
    runningFingerprint: runningKeyFingerprint(),
    holdsInstanceSecrets: carriesInstanceSecrets,
  });
  if (keyVerdict.kind === "blocked" && !opts.acceptKeyMismatch) {
    throw new Error(`${keyVerdict.message} Restore anyway only if the env vars are expendable.`);
  }

  // Restore commands and mount paths are live config, read from the volume row.
  const vol = backup.appId
    ? await db.query.volumes.findFirst({
        where: and(eq(volumes.appId, backup.appId), eq(volumes.name, backup.volumeName)),
      })
    : await db.query.volumes.findFirst({
        where: and(isNull(volumes.appId), eq(volumes.name, backup.volumeName)),
      });

  const storage = createBackupStorage(backup.target);
  const logLines: string[] = [];
  const log = (msg: string) => {
    logLines.push(`[${new Date().toISOString()}] ${msg}`);
  };

  const tmpDir = join(BACKUPS_DIR, `.tmp-restore-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const archivePath = join(tmpDir, strategy === "dump" ? "dump.gz" : "volume.tar.gz");

  // Only app data is quiesced. Stopping a system volume's mounts would stop this process.
  const quiesceTarget = (dest: RestoreDestination): RestoreDestination | null => {
    if (backup.appId && backup.app && !isSelfApp(backup.app.name)) return dest;
    log("WARNING: restoring without stopping the containers that use this data");
    return null;
  };

  try {
    if (keyVerdict.kind !== "proceed") {
      log(`WARNING: ${keyVerdict.message}`);
    }

    // 1. Download
    log(`Downloading backup from ${backup.storagePath}`);
    const { encrypted } = await fetchArchive(
      storage,
      { storagePath: backup.storagePath, archiveKey: backup.archiveKey },
      archivePath,
      log,
    );
    log("Download complete");

    // 2. Validate. Encrypted archives are proven complete by their final-chunk tag.
    const wasEmptyWhenWritten =
      encrypted || (backup.sizeBytes != null && backup.sizeBytes < MIN_VALID_GZIP_BYTES);
    await verifyArchive(archivePath, "Downloaded backup", wasEmptyWhenWritten);
    if (backup.checksum) {
      const downloadChecksum = `sha256:${await checksumFile(archivePath)}`;
      if (downloadChecksum !== backup.checksum) {
        throw new Error(
          `Checksum mismatch — expected ${backup.checksum}, got ${downloadChecksum}. Archive may be corrupt.`
        );
      }
      log("Checksum verified");
    }

    // 3. Excluded paths come from the archive's record, never current patterns, or the swap deletes data.
    const protectedPaths = (backup.excludedPaths ?? []).map(assertExcludedPath);
    if (strategy === "tar" && protectedPaths.length > 0) {
      await writeFile(join(tmpDir, PROTECT_LIST_FILE), protectListBody(protectedPaths));
      log(`Keeping ${protectedPaths.length} excluded path(s) as found at the destination`);
    }

    // 4. Restore
    if (strategy === "dump") {
      // Restore config is read live. A spec resolves the container now.
      if (vol?.backupSpec) {
        const spec = vol.backupSpec;
        if (!backup.app || !backup.appId) {
          throw new Error("A dump spec needs an app to resolve against");
        }
        log(`Restore spec: ${describeDumpSpec(spec)}`);
        const env = await resolveDefaultEnv(backup.appId);
        const container = await resolveDbContainer(
          spec,
          { id: backup.appId, name: backup.app.name },
          env?.name,
          log,
        );
        if (!container) {
          throw new Error(
            `No running container for service "${spec.service}" — start the app before restoring`,
          );
        }
        await restoreDumpWithSnapshot({
          backupId,
          kind: spec.kind,
          containerId: container.id,
          containerEnv: container.env,
          archivePath,
          tmpDir,
          log,
        });
      } else if (vol?.backupMeta?.restoreCmd) {
        // restoreCmd receives the dump via stdin.
        log(`Restoring via: ${vol.backupMeta.restoreCmd}`);
        await execFileAsync(
          "bash",
          ["-c", `set -o pipefail; gunzip -c "${archivePath}" | ${vol.backupMeta.restoreCmd}`],
          { timeout: 600_000 },
        );
      } else {
        throw new Error("Dump restore requires a backupSpec or restoreCmd on the volume");
      }
    } else if (vol?.type === "bind") {
      // The script deletes the destination first. Three checks must pass for a host path.
      if (!vol.source) {
        throw new Error("Bind restore has no host path recorded on the volume");
      }
      const safeSource = assertSafeBindSource(vol.source, {
        dockerRoot: await dockerDataRoot(),
        label: "restore destination",
      });

      // The archive's record of its source wins over the volume row.
      if (backup.resolvedSource && backup.resolvedSource !== safeSource) {
        throw new Error(
          `This archive was taken from ${backup.resolvedSource}, but the volume now points at ${safeSource} — refusing to restore into a different location`,
        );
      }
      if (!backup.resolvedSource) {
        throw new Error(
          "This archive predates source recording, so where it came from cannot be confirmed — refusing to overwrite a host path",
        );
      }

      // Never create a missing host path: it means the path is wrong.
      const live = await preflightBindSource(safeSource);
      const archivedKind = backup.sourceKind ?? "directory";
      if (live.kind !== archivedKind) {
        throw new Error(
          `This archive holds a ${archivedKind}, but ${safeSource} is now a ${live.kind} — refusing to restore`,
        );
      }

      log(`Restoring into host ${live.kind} ${safeSource}`);
      const mount =
        live.kind === "file"
          ? `${safeSource}:/data/${FILE_PAYLOAD_NAME}`
          : `${safeSource}:/data`;
      const dest = quiesceTarget({ kind: "bind", path: safeSource });
      await restoreFilesWithSnapshot({
        backupId,
        dest,
        mount,
        snapshotScript: live.kind === "file" ? buildFileBackupScript() : buildTarBackupScript(),
        restoreScript: live.kind === "file" ? buildFileRestoreScript() : buildTarRestoreScript(),
        tmpDir,
        timeoutMs: 1_800_000,
        log,
      });
    } else {
      if (!backup.app || !backup.appId) {
        throw new Error("Tar restore requires an app context");
      }
      assertSafeName(backup.app.name);
      assertSafeName(backup.volumeName);

      let dockerVolumeName = await resolveDockerVolume(
        backup.appId,
        backup.app.name,
        backup.volumeName,
        vol?.mountPath ?? null,
        log,
      );
      if (!dockerVolumeName) {
        // Fresh app: create the env-scoped volume, never a slot name the app won't mount.
        const env = await resolveDefaultEnv(backup.appId);
        dockerVolumeName = `${backup.app.name}-${env.name}_${backup.volumeName}`;
        assertSafeName(dockerVolumeName);
        log(`Creating volume ${dockerVolumeName}`);
        await execFileAsync("docker", ["volume", "create", dockerVolumeName], { timeout: 10_000 });
      }

      log(`Restoring to volume ${dockerVolumeName}`);
      await restoreFilesWithSnapshot({
        backupId,
        dest: quiesceTarget({ kind: "volume", name: dockerVolumeName }),
        mount: `${dockerVolumeName}:/data`,
        snapshotScript: buildTarBackupScript(),
        restoreScript: buildTarRestoreScript(),
        tmpDir,
        timeoutMs: 600_000,
        log,
      });
    }

    log("Restore complete");

    // Whether the restored rows open with the running key.
    if (carriesInstanceSecrets) {
      const { probeDecryptability } = await import("@/lib/crypto/key-escrow");
      const probe = await probeDecryptability();
      if (probe.undecryptable > 0) {
        log(
          `WARNING: ${probe.undecryptable} of ${probe.encrypted} restored encrypted values cannot be decrypted ` +
            `with the running ENCRYPTION_MASTER_KEY. Affected: ${probe.samples.join(", ")}`,
        );
      } else {
        log(`Verified ${probe.encrypted} restored encrypted value(s) decrypt with the running key`);
      }
    }

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

/** Pre-signed download URL for an archive. Null when the backend can't sign or the archive is encrypted. */
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

  if (backup.archiveKey) return null;

  const storage = createBackupStorage(backup.target);

  if (!storage.getDownloadUrl) {
    return null;
  }

  return storage.getDownloadUrl(backup.storagePath, 3600);
}

/** Download a backup to a decrypted local temp file. Caller cleans it up. */
export async function downloadBackupToTemp(
  backupId: string,
  logFn?: (msg: string) => void,
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
  try {
    await fetchArchive(
      storage,
      { storagePath: backup.storagePath, archiveKey: backup.archiveKey },
      destPath,
      logFn,
    );
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return destPath;
}
