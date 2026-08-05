// ---------------------------------------------------------------------------
// Running a restore drill.
//
// Everything here happens in throwaway containers and volumes. A drill must
// never be able to reach the live copy of anything — that is the one property
// that makes it safe to run on a schedule.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { backups, volumes } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import { createReadStream } from "fs";
import { rm } from "fs/promises";
import { dirname } from "path";
import { logger } from "@/lib/logger";
import { downloadBackupToTemp, strategyFromStoragePath, type ArchiveStrategy } from "./engine";
import { resolveDbContainer } from "./resolve-db-container";
import { inspectContainer } from "@/lib/docker/client";
import {
  judgeArchiveDrill,
  judgeDrill,
  scratchContainerName,
  scratchDatabaseFor,
  type DrillOutcome,
} from "./drill-plan";
import { resolveDefaultEnv } from "@/lib/docker/resolve-env";

const log = logger.child("drill");
const execFileAsync = promisify(execFile);

const READY_ATTEMPTS = 30;
const READY_INTERVAL_MS = 2000;

export type DrillResult = {
  backupId: string;
  outcome: DrillOutcome;
  detail: string;
  durationMs: number;
  log: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until the scratch database accepts connections, or give up. */
async function waitForReady(container: string, readyArgv: string[]): Promise<boolean> {
  for (let i = 0; i < READY_ATTEMPTS; i++) {
    try {
      await execFileAsync("docker", ["exec", container, ...readyArgv], { timeout: 15_000 });
      return true;
    } catch {
      await sleep(READY_INTERVAL_MS);
    }
  }
  return false;
}

/**
 * Feed a gzipped dump into a container's stdin and return its exit code.
 *
 * No shell: the argv goes to docker as data, so nothing here needs quoting and
 * nothing can be reinterpreted.
 */
async function streamInto(
  argv: string[],
  archivePath: string,
  logFn: (m: string) => void,
): Promise<number> {
  const child = spawn("docker", argv, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => {
    if (stderr.length < 4000) stderr += String(c);
  });

  const exited = new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });

  try {
    await pipeline(createReadStream(archivePath), createGunzip(), child.stdin);
  } catch {
    // A restore that rejects the stream closes stdin early; the exit code is
    // the verdict, not this.
  }

  const code = await exited;
  if (code !== 0 && stderr.trim()) logFn(`scratch restore stderr: ${stderr.trim().slice(0, 400)}`);
  return code;
}

/**
 * Restore a dump into a scratch database of the same image and count what it
 * created. The scratch container is published nowhere and removed either way.
 */
async function drillDump(
  archivePath: string,
  vol: { appId: string | null; appName: string | null; backupSpec: { kind: string; service: string } | null },
  logFn: (m: string) => void,
): Promise<{ outcome: DrillOutcome; detail: string }> {
  const spec = vol.backupSpec;
  if (!spec || !vol.appId || !vol.appName) {
    return { outcome: "unsupported", detail: "dump drill needs a backup spec and an app" };
  }

  // The scratch instance mirrors the live one, so the dump's ownership and
  // \connect lines resolve.
  const env = await resolveDefaultEnv(vol.appId);
  const live = await resolveDbContainer(spec as never, { id: vol.appId, name: vol.appName }, env?.name, logFn);
  if (!live) {
    return { outcome: "unsupported", detail: `no running "${spec.service}" container to model the drill on` };
  }
  const liveImage = (await inspectContainer(live.id)).image;

  const plan = scratchDatabaseFor(spec.kind as never, liveImage, live.env);
  if (!plan) {
    return { outcome: "unsupported", detail: `no drill defined for ${spec.kind}` };
  }

  const container = scratchContainerName(nanoid(8).toLowerCase());
  const envArgs = plan.env.flatMap((e) => ["-e", e]);

  logFn(`Starting scratch ${spec.kind} (${plan.image}) as ${container}`);
  await execFileAsync(
    "docker",
    ["run", "-d", "--rm", "--name", container, "--network", "none", ...envArgs, plan.image],
    { timeout: 120_000 },
  );

  try {
    if (!(await waitForReady(container, plan.readyArgv))) {
      return { outcome: "failed", detail: "scratch database never became ready" };
    }

    const restoreExitCode = await streamInto(
      ["exec", "-i", container, ...plan.restoreArgv],
      archivePath,
      logFn,
    );

    let objectCount: number | null = null;
    try {
      const { stdout } = await execFileAsync("docker", ["exec", container, ...plan.countArgv], { timeout: 60_000 });
      const parsed = Number.parseInt(String(stdout).trim(), 10);
      objectCount = Number.isFinite(parsed) ? parsed : null;
    } catch {
      objectCount = null;
    }

    const verdict = judgeDrill({ restoreExitCode, objectCount });
    logFn(`Drill verdict: ${verdict.outcome} — ${verdict.detail}`);
    return verdict;
  } finally {
    await execFileAsync("docker", ["rm", "-f", container], { timeout: 60_000 }).catch(() => {});
  }
}

/** Extract a tar archive into a scratch volume and count what came out. */
async function drillArchive(
  archivePath: string,
  logFn: (m: string) => void,
): Promise<{ outcome: DrillOutcome; detail: string }> {
  const scratchVolume = scratchContainerName(nanoid(8).toLowerCase());
  await execFileAsync("docker", ["volume", "create", scratchVolume], { timeout: 30_000 });

  try {
    let extractExitCode = 0;
    let fileCount: number | null = null;
    try {
      const { stdout } = await execFileAsync(
        "docker",
        [
          "run", "--rm", "--network", "none",
          "-v", `${scratchVolume}:/restore`,
          "-v", `${dirname(archivePath)}:/archive:ro`,
          "alpine", "sh", "-c",
          `set -e; tar xzf "/archive/$(basename '${archivePath}')" -C /restore; find /restore -type f | wc -l`,
        ],
        { timeout: 900_000 },
      );
      const parsed = Number.parseInt(String(stdout).trim(), 10);
      fileCount = Number.isFinite(parsed) ? parsed : null;
    } catch (err) {
      extractExitCode = (err as { code?: number }).code ?? 1;
      logFn(`Extract into scratch failed: ${err instanceof Error ? err.message.slice(0, 300) : err}`);
    }

    const verdict = judgeArchiveDrill({ extractExitCode, fileCount });
    logFn(`Drill verdict: ${verdict.outcome} — ${verdict.detail}`);
    return verdict;
  } finally {
    await execFileAsync("docker", ["volume", "rm", "-f", scratchVolume], { timeout: 60_000 }).catch(() => {});
  }
}

/**
 * Verify a backup is restorable, without touching anything live.
 *
 * Records the verdict on the backup row so "last verified" can be shown apart
 * from "last succeeded" — a job green for ninety days and never once restored
 * should not read the same as one drilled last week.
 */
export async function runRestoreDrill(backupId: string): Promise<DrillResult> {
  const startedAt = Date.now();
  const lines: string[] = [];
  const logFn = (m: string) => {
    lines.push(`[${new Date().toISOString()}] ${m}`);
  };

  const backup = await db.query.backups.findFirst({
    where: eq(backups.id, backupId),
    with: { app: true },
  });
  if (!backup) throw new Error(`Backup not found: ${backupId}`);
  if (backup.status !== "success") throw new Error("Only a successful backup can be drilled");
  if (!backup.storagePath) throw new Error("Backup has no storage path");

  const strategy: ArchiveStrategy | null =
    (backup.strategy as ArchiveStrategy | null) ?? strategyFromStoragePath(backup.storagePath);

  const vol = backup.appId
    ? await db.query.volumes.findFirst({
        where: and(eq(volumes.appId, backup.appId), eq(volumes.name, backup.volumeName ?? "")),
      })
    : await db.query.volumes.findFirst({
        where: and(isNull(volumes.appId), eq(volumes.name, backup.volumeName ?? "")),
      });

  let archivePath: string | null = null;
  try {
    logFn(`Downloading ${backup.storagePath}`);
    archivePath = await downloadBackupToTemp(backupId);

    const verdict =
      strategy === "dump"
        ? await drillDump(
            archivePath,
            {
              appId: backup.appId,
              appName: backup.app?.name ?? null,
              backupSpec: vol?.backupSpec ?? null,
            },
            logFn,
          )
        : await drillArchive(archivePath, logFn);

    await db
      .update(backups)
      .set({
        verifiedAt: new Date(),
        verifyOutcome: verdict.outcome,
        verifyDetail: verdict.detail,
      })
      .where(eq(backups.id, backupId));

    return {
      backupId,
      outcome: verdict.outcome,
      detail: verdict.detail,
      durationMs: Date.now() - startedAt,
      log: lines.join("\n"),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logFn(`Drill error: ${detail}`);
    await db
      .update(backups)
      .set({ verifiedAt: new Date(), verifyOutcome: "failed", verifyDetail: detail })
      .where(eq(backups.id, backupId))
      .catch(() => {});
    log.error(`Drill failed for ${backupId}: ${detail}`);
    return { backupId, outcome: "failed", detail, durationMs: Date.now() - startedAt, log: lines.join("\n") };
  } finally {
    if (archivePath) {
      await rm(dirname(archivePath), { recursive: true, force: true }).catch(() => {});
    }
  }
}
