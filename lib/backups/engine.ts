import { db } from "@/lib/db";
import {
  backupJobs,
  backups,
  volumes,
} from "@/lib/db/schema";
import { eq, and, isNull, desc, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { spawn } from "child_process";
import { pipeline } from "stream/promises";
import { createGzip, createGunzip } from "zlib";
import { mkdir, rm, stat } from "fs/promises";
import { resolve, join } from "path";
import type { BackupStorage } from "./storage-port";
import { createBackupStorage } from "./storage-factory";
import { assertSafeName } from "@/lib/docker/validate";
import { isUncapturedSource, uncapturedReason } from "./coverage";
import { exclusionReason, isBackupSelected } from "./durability";
import { assertSafeBindSource } from "@/lib/docker/mount-paths";
import { buildDumpArgv, buildRestoreArgv, describeDumpSpec, type DumpSpec } from "./dump-spec";
import { resolveDbContainer } from "./resolve-db-container";
import {
  DIRECTORY_SOURCE_MARKER,
  EMPTY_SOURCE_MARKER,
  FILE_PAYLOAD_NAME,
  FILE_SOURCE_MARKER,
  MIN_VALID_GZIP_BYTES,
  buildBindPreflightScript,
  buildFileBackupScript,
  buildFileRestoreScript,
  buildTarBackupScript,
  buildTarRestoreScript,
} from "./archive";
import { listContainers, inspectContainer } from "@/lib/docker/client";
import { resolveDefaultEnv } from "@/lib/docker/resolve-env";
import { logger } from "@/lib/logger";
import type { BusEvent } from "@/lib/bus/events";
import { execFileAsync } from "@/lib/utils/exec";

const log = logger.child("backup");


// Local staging dir for backup archives before upload. Must be writable by the
// app user AND host-visible: the engine bind-mounts it into a one-shot `alpine`
// container via `docker run -v`, so a path that only exists inside this
// container (e.g. cwd /app) can't be mounted. In production the app runs as a
// non-root user and /app is not writable, so default under VARDO_HOME_DIR — the
// app-owned data dir that is bind-mounted at the same path on the host. Falls
// back to ./.host/backups for local dev (where VARDO_HOME_DIR is unset).
const BACKUPS_DIR = resolve(
  process.env.VARDO_BACKUPS_DIR ||
    (process.env.VARDO_HOME_DIR
      ? join(process.env.VARDO_HOME_DIR, "backups-staging")
      : "./.host/backups"),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** skipped — the source is real but the engine cannot capture it (bind mount). */
export type BackupOutcome = "success" | "failed" | "skipped";

/** Archive format. Fixed when the archive is written; restore must not re-derive it. */
export type ArchiveStrategy = "tar" | "dump";

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
  durationMs: number;
};

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
  /** Owning org, so an instance-level job reports progress to each app's org. */
  orgId: string | null;
  orgSlug: string | null;
  type: "named" | "bind";
  source: string | null;
  backupStrategy: string;
  backupMeta: { dumpCmd: string; restoreCmd: string } | null;
  backupSpec: DumpSpec | null;
  durability: string | null;
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

/** Archive format encoded in the storage key. Fallback for rows written before `backup.strategy`. */
export function strategyFromStoragePath(storagePath: string): ArchiveStrategy | null {
  if (storagePath.endsWith(".dump.gz")) return "dump";
  if (storagePath.endsWith(".tar.gz")) return "tar";
  return null;
}

/**
 * Verify a gzipped archive is valid:
 * - Passes gzip integrity check (not truncated or corrupted)
 * - Holds at least one entry, unless the source was confirmed empty
 *
 * Pass `sourceWasEmpty` only on evidence from the source itself — an empty
 * volume and a broken pipe both produce a tiny file, and size cannot tell them
 * apart.
 */
async function verifyArchive(
  filePath: string,
  label: string,
  sourceWasEmpty = false,
): Promise<number> {
  const info = await stat(filePath);

  // gzip -t validates the entire compressed stream
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
    const { stdout } = await execFileAsync(
      "docker",
      ["run", "--rm", "-v", `${dockerVolumeName}:/data`, "-v", `${tmpDir}:/backup`, "alpine", "sh", "-c", buildTarBackupScript()],
      { timeout: 600_000 },
    );

    // The container's own verdict on the source. A container that dies
    // mid-archive fails `docker run` rather than reaching here.
    const sourceWasEmpty = String(stdout).includes(EMPTY_SOURCE_MARKER);
    if (sourceWasEmpty) {
      logFn(`Volume ${dockerVolumeName} is empty — archived 0 files`);
    }

    const archivePath = join(tmpDir, archiveFile);
    await verifyArchive(archivePath, `Volume ${dockerVolumeName}`, sourceWasEmpty);

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
 * Strategy: dump — write a dump to stdout and gzip it.
 *
 * `run` receives the destination and issues the command. Two callers: a spec,
 * resolved to a container and argv when the run happens, and the legacy stored
 * shell string.
 */
async function backupVolumeDump(
  run: (dumpFile: string, logFn: (msg: string) => void) => Promise<void>,
  storageKey: string,
  storage: BackupStorage,
  logFn: (msg: string) => void,
): Promise<{ sizeBytes: number; checksum: string }> {
  const tmpDir = join(BACKUPS_DIR, `.tmp-${nanoid(8)}`);
  await ensureDir(tmpDir);
  const dumpFile = join(tmpDir, "dump.gz");

  try {
    await run(dumpFile, logFn);

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
 * Stream a dump straight from `docker` into a gzip file.
 *
 * No shell, so the argv is data rather than something to be parsed. Streamed
 * rather than buffered, because a real database does not fit in memory.
 *
 * Both the exit code and the pipeline must succeed. Checking only the pipeline
 * stores whatever a failing pg_dump managed to write before it gave up.
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
 * Establish what a bind source actually is, from inside the container.
 *
 * Has to run here rather than in Node: Vardo talks to the daemon over a socket
 * while `-v` resolves against the *host* filesystem, so `fs.stat` from this
 * process inspects the wrong machine and answers confidently about nothing.
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

/**
 * Archive a host path, directory or single file.
 *
 * Mounted read-only throughout: this path only reads, and `:ro` means a bug
 * here cannot become a write to the host.
 */
async function backupBindTar(
  hostSource: string,
  storageKey: string,
  storage: BackupStorage,
  logFn: (msg: string) => void,
): Promise<{ sizeBytes: number; checksum: string; kind: BindSourceKind }> {
  const tmpDir = join(BACKUPS_DIR, `.tmp-${nanoid(8)}`);
  await ensureDir(tmpDir);

  try {
    const safeSource = assertSafeBindSource(hostSource, {
      dockerRoot: await dockerDataRoot(),
      label: "bind source",
    });

    const { kind, empty } = await preflightBindSource(safeSource);

    // For a named volume an empty source is believable — something already
    // proved the volume exists. A bind source Docker just created from a typo
    // looks identical, so this is a failure rather than a waiver.
    if (empty) {
      throw new Error(
        `${safeSource} is empty — refusing to record a backup that would restore as nothing`,
      );
    }

    logFn(`Archiving host ${kind} ${safeSource}`);
    const mount =
      kind === "file"
        ? `${safeSource}:/data/${FILE_PAYLOAD_NAME}:ro`
        : `${safeSource}:/data:ro`;
    const script = kind === "file" ? buildFileBackupScript() : buildTarBackupScript();

    await execFileAsync(
      "docker",
      ["run", "--rm", "-v", mount, "-v", `${tmpDir}:/backup`, "alpine", "sh", "-c", script],
      { timeout: 1_800_000 },
    );

    const archivePath = join(tmpDir, "volume.tar.gz");
    await verifyArchive(archivePath, `Bind mount ${safeSource}`);

    const checksum = await checksumFile(archivePath);
    logFn(`Checksum: sha256:${checksum.slice(0, 16)}...`);

    logFn(`Uploading to ${storageKey}`);
    const { sizeBytes } = await storage.upload(storageKey, archivePath);

    logFn(`Upload complete (${sizeBytes} bytes)`);
    return { sizeBytes, checksum, kind };
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
 * Resolve the real Docker volume name backing an app's volume.
 *
 * Persistent volumes are **env-scoped** (`${app}-${env}_${vol}`) and declared
 * `external: true` so they're shared across blue/green slots and survive swaps —
 * they are NOT slot-scoped. Resolution order (#756):
 *   1. **Inspect the app's running container(s) in this environment** and return
 *      the volume actually mounted at `mountPath`. Authoritative and
 *      naming-agnostic — backs up the volume Docker is really using, not a
 *      guessed name.
 *   2. **Derive the env-scoped name** `${app}-${env}_${vol}` (default env
 *      "production") and confirm it exists — covers a stopped app / fresh
 *      restore where there's no container to inspect.
 *   3. **Legacy slot names** `${app}-blue_${vol}` / `${app}-green_${vol}`.
 * Returns null if none resolve.
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

  // Every environment and slot shares `vardo.project`; `vardo.environment` is
  // what separates them. Resolve it once and scope both lookups below by it.
  const env = appId ? await resolveDefaultEnv(appId) : null;

  // 1. Authoritative: the volume Docker actually has mounted at mountPath.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a backup run for a given job.
 * Collects volumes from linked apps AND directly linked volumes,
 * then dispatches each by its backup strategy. Pass `appIds` to run a subset
 * of the job's apps.
 */
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

  // Defense in depth against a link written before the routes were scoped.
  // An instance-level job has no org and legitimately spans them.
  const owned = job.organizationId
    ? job.backupJobApps.filter((bja) => bja.app.organizationId === job.organizationId)
    : job.backupJobApps;

  const scope = options.appIds ? new Set(options.appIds) : null;
  const scoped = scope ? owned.filter((bja) => scope.has(bja.app.id)) : owned;
  // A retired app's volumes are empty or gone, so a scheduled run against it
  // fails every night with nothing to fix. An explicit request still runs.
  const jobApps = options.appIds
    ? scoped
    : scoped.filter((bja) => bja.app.status !== "missing" && bja.app.status !== "stopped");
  const jobVolumes = scope
    ? job.backupJobVolumes.filter((bjv) => bjv.volume.appId && scope.has(bjv.volume.appId))
    : job.backupJobVolumes;

  const { executeHooks } = await import("@/lib/hooks/execute");
  const hookResult = await executeHooks("before.backup.run", {
    jobId,
    organizationId: job.organizationId,
    apps: jobApps.map((bja) => ({ id: bja.app.id, name: bja.app.name })),
  }, { organizationId: job.organizationId ?? undefined });

  if (!hookResult.allowed) {
    throw new Error(`Backup blocked by hook: ${hookResult.blockedBy?.hookName}`);
  }

  const storage = createBackupStorage(job.target);
  const ts = timestamp();
  await ensureDir(BACKUPS_DIR);

  // Collect all volumes to back up
  const volumesToBackup: VolumeToBackup[] = [];
  // Deliberately left out by their durability class. Kept so a run that
  // captures nothing because there was nothing to capture can say so.
  const excludedSources: { name: string; appName: string | null; reason: string }[] = [];

  // From linked apps: find their persistent volumes
  for (const bja of jobApps) {
    const app = bja.app;
    const orgSlug = app.organization.slug;

    const appVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, app.id),
    });
    const persistentVols = appVolumes.filter(isBackupSelected);

    for (const vol of persistentVols) {
      // Classified as reconstructible or held elsewhere. Not a skip — the job
      // does not cover it at all, so it gets no row and no archive.
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
        orgId: app.organizationId,
        orgSlug,
        type: vol.type,
        source: vol.source,
        backupStrategy: vol.backupStrategy,
        backupMeta: vol.backupMeta,
        backupSpec: vol.backupSpec,
        durability: vol.durability,
      });
    }
  }

  // From directly linked volumes (system volumes, etc.)
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
      orgId: null,
      orgSlug: null,
      type: vol.type,
      source: vol.source,
      backupStrategy: vol.backupStrategy,
      backupMeta: vol.backupMeta,
      backupSpec: vol.backupSpec,
      durability: vol.durability,
    });
  }

  if (volumesToBackup.length === 0) {
    // Every source was classified out. The run did its whole job, so it must
    // refresh lastRunAt — otherwise the stale-backup deploy condition flags
    // this job forever for correctly archiving nothing.
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
    return [];
  }

  // Live progress for the backups UI. Best-effort throughout: the import, the
  // emit and anything they throw are contained so a bus fault cannot abort a run.
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

  // Back up each volume
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
        appId: vol.appId,
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

    // Determine storage key based on context
    const strategy: ArchiveStrategy = vol.backupStrategy === "dump" ? "dump" : "tar";
    const ext = strategy === "dump" ? "dump.gz" : "tar.gz";
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
      strategy,
      startedAt,
    });

    try {
      log(`Backing up volume ${vol.name} (strategy: ${strategy})`);

      let result: { sizeBytes: number; checksum: string };
      let resolvedSource: string | null = null;
      let sourceKind: string | null = null;

      if (strategy === "dump") {
        const spec = vol.backupSpec;
        const legacyCmd = vol.backupMeta?.dumpCmd;
        if (!spec && !legacyCmd) {
          throw new Error(`Dump strategy requires a backupSpec or dumpCmd (volume: ${vol.name})`);
        }

        // A spec resolves its container now; a stored command names one that
        // was true when it was written. Prefer the spec whenever there is one.
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
        const bind = await backupBindTar(vol.source, storageKey, storage, log);
        result = bind;
        resolvedSource = vol.source;
        sourceKind = bind.kind;
      } else {
        // tar strategy — need to resolve the Docker volume name
        if (!vol.appName) {
          throw new Error(`Tar backup requires an app name (volume: ${vol.name})`);
        }
        const dockerVolumeName = await resolveDockerVolume(vol.appId, vol.appName, vol.name, vol.mountPath, log);
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
          resolvedSource,
          sourceKind,
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
        outcome: "failed",
        sizeBytes: 0,
        storagePath: "",
        error: errorMsg,
        durationMs,
      });
    }
  }

  // lastRunAt feeds the stale-backup deploy condition, so only a run covering
  // the whole job AND capturing at least one archive may refresh it.
  const coveredWholeJob =
    jobApps.length === job.backupJobApps.length &&
    jobVolumes.length === job.backupJobVolumes.length;
  const capturedSomething = results.some((r) => r.outcome === "success");
  if (coveredWholeJob && capturedSomething) {
    const finishedRunAt = new Date();
    await db
      .update(backupJobs)
      .set({ lastRunAt: finishedRunAt, updatedAt: finishedRunAt })
      .where(eq(backupJobs.id, jobId));
  }

  // Notifications
  try {
    const succeeded = results.filter((r) => r.outcome === "success");
    const failed = results.filter((r) => r.outcome === "failed");
    const skipped = results.filter((r) => r.outcome === "skipped");
    // A run that captured nothing is not a success.
    const capturedNothing = succeeded.length === 0;
    const hasFailures = failed.length > 0 || capturedNothing;
    const allSuccess = !hasFailures;
    const notes = [
      skipped.length > 0 ? `${skipped.length} skipped` : null,
      excludedSources.length > 0 ? `${excludedSources.length} excluded by durability` : null,
    ].filter(Boolean);
    const skippedNote = notes.length > 0 ? ` (${notes.join(", ")})` : "";

    if (job.organizationId && ((hasFailures && job.notifyOnFailure) || (allSuccess && job.notifyOnSuccess))) {
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
      // System-level job — log to console
      if (hasFailures && job.notifyOnFailure) {
        log.error(`${job.name} FAILED — ${[...failed, ...skipped].map((r) => `${r.volumeName}: ${r.error}`).join("; ")}`);
      } else if (!hasFailures && job.notifyOnSuccess) {
        log.info(`${job.name} succeeded (${results.reduce((s, r) => s + r.sizeBytes, 0)} bytes)${skippedNote}`);
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
 * Apply the retention policy PER VOLUME. A job with N volumes produces N
 * backups per run (one archive each, same timestamp); retention timelines must
 * not be shared, or e.g. keepLast=1 would keep a single archive across all
 * volumes and prune the rest — silently dropping every volume but one each run.
 * Group by volumeName and union the keepers from each volume's own timeline.
 * Entries must be sorted newest-first (selectKeepers relies on it).
 */
export function selectKeepersByVolume(
  entries: { id: string; finishedAt: Date; volumeName: string | null }[],
  policy: RetentionPolicy,
): Set<string> {
  const byVolume = new Map<string, { id: string; finishedAt: Date }[]>();
  for (const e of entries) {
    const key = e.volumeName ?? "";
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

  const keepers = selectKeepersByVolume(eligible, policy);
  const toPrune = eligible.filter((b) => !keepers.has(b.id));

  if (toPrune.length === 0) return 0;

  // Delete from storage, then mark as pruned
  const storage = createBackupStorage(job.target);

  // Only rows whose object is really gone may be marked pruned — otherwise the
  // DB claims an object was deleted while it still exists and is still billed.
  const pruneIds: string[] = [];
  let undeleted = 0;

  for (const backup of toPrune) {
    if (backup.storagePath) {
      try {
        await storage.delete(backup.storagePath);
      } catch (err) {
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
      .set({ status: "pruned" })
      .where(inArray(backups.id, pruneIds));
  }

  if (undeleted > 0) {
    log.warn(`${undeleted} backup(s) left in storage for job ${job.name} — delete failed, rows kept`);
  }

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

  // The archive format is whatever was written, not whatever the volume is
  // configured for now — that row may have been edited, renamed or deleted
  // since. Guessing it wrong restores a dump as a tar and empties the volume.
  const strategy: ArchiveStrategy | null =
    (backup.strategy as ArchiveStrategy | null) ?? strategyFromStoragePath(backup.storagePath);

  if (strategy !== "tar" && strategy !== "dump") {
    throw new Error(
      `Cannot determine the archive format of backup ${backupId} (storage path: ${backup.storagePath}) — refusing to restore`,
    );
  }

  // Restore commands and mount paths are live config, read from the volume row.
  const vol = backup.appId
    ? await db.query.volumes.findFirst({
        where: and(eq(volumes.appId, backup.appId), eq(volumes.name, backup.volumeName)),
      })
    : await db.query.volumes.findFirst({
        where: and(isNull(volumes.appId), eq(volumes.name, backup.volumeName)),
      });

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

    // 2. Validate archive integrity. A row recorded below the floor was written
    // from a source verified empty; the checksum below proves it came back intact.
    const wasEmptyWhenWritten =
      backup.sizeBytes != null && backup.sizeBytes < MIN_VALID_GZIP_BYTES;
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

    // 3. Restore by strategy
    if (strategy === "dump") {
      // Restore config is read live, the same as the dump side. A spec resolves
      // the container now; a stored command names whatever was running when it
      // was written.
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
        await streamDockerRestore(
          buildRestoreArgv(spec.kind, container.id, container.env),
          archivePath,
          log,
        );
      } else if (vol?.backupMeta?.restoreCmd) {
        // restoreCmd receives the dump via stdin (e.g. "docker exec -i pg psql -U user db")
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
      // Restore is the destructive direction: the script deletes the
      // destination's contents before writing. Three things must agree before
      // that runs against a host path.
      if (!vol.source) {
        throw new Error("Bind restore has no host path recorded on the volume");
      }
      const safeSource = assertSafeBindSource(vol.source, {
        dockerRoot: await dockerDataRoot(),
        label: "restore destination",
      });

      // The volume row may have been edited since the archive was written.
      // The archive's own record of where it came from is the authority.
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

      // Never conjure the destination. For a named volume "missing" is
      // recoverable; for a host path it means the path is wrong.
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
      const script = live.kind === "file" ? buildFileRestoreScript() : buildTarRestoreScript();
      await execFileAsync(
        "docker",
        ["run", "--rm", "-v", mount, "-v", `${tmpDir}:/backup`, "alpine", "sh", "-c", script],
        { timeout: 1_800_000 },
      );
    } else {
      // tar restore — need app context for volume name resolution
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
        // Nothing exists yet (restoring into a fresh app) — create the canonical
        // env-scoped volume so the running app actually reads the restored data.
        // (NOT a blue/green slot name, which the app would never mount — #756.)
        const env = await resolveDefaultEnv(backup.appId);
        dockerVolumeName = `${backup.app.name}-${env.name}_${backup.volumeName}`;
        assertSafeName(dockerVolumeName);
        log(`Creating volume ${dockerVolumeName}`);
        await execFileAsync("docker", ["volume", "create", dockerVolumeName], { timeout: 10_000 });
      }

      log(`Restoring to volume ${dockerVolumeName}`);
      await execFileAsync(
        "docker",
        ["run", "--rm", "-v", `${dockerVolumeName}:/data`, "-v", `${tmpDir}:/backup`, "alpine", "sh", "-c", buildTarRestoreScript()],
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
