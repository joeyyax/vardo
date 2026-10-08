// Works the app queue: restore each app's archives, redeploy it, then restore its database dumps.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, volumes } from "@/lib/db/schema";
import { instanceRestoreApps, instanceRestores, type RestoreArchivePlan } from "@/lib/db/schema/restore";
import { restoreBackup } from "@/lib/backups/engine";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { execFileAsync } from "@/lib/utils/exec";
import { logger } from "@/lib/logger";
import { nextRunnable } from "./plan";
import { archivesForApps, currentRestore, finishIfSettled, requeueInterrupted, restoreItems } from "./queue";
import { dockerEnv } from "@/lib/docker/docker-env";

const log = logger.child("instance-restore");

const POLL_MS = 2_000;

const g = globalThis as unknown as { __vardo_restore_worker?: Promise<void> };

/** Start the worker if it isn't running. */
export function kickRestoreWorker(opts: { requeueInterrupted?: boolean } = {}): void {
  if (g.__vardo_restore_worker) return;
  g.__vardo_restore_worker = workLoop(opts)
    .catch((err) => log.error("Restore worker stopped:", err))
    .finally(() => {
      g.__vardo_restore_worker = undefined;
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function workLoop(opts: { requeueInterrupted?: boolean }): Promise<void> {
  const run = await currentRestore();
  if (!run) return;
  if (opts.requeueInterrupted) {
    const requeued = await requeueInterrupted(run.id);
    if (requeued > 0) log.info(`Requeued ${requeued} app(s) interrupted by a restart`);
  }
  if (await finishIfSettled(run.id)) return;
  await db.update(instanceRestores).set({ status: "running", finishedAt: null }).where(eq(instanceRestores.id, run.id));

  const inFlight = new Map<string, Promise<void>>();
  for (;;) {
    const items = await restoreItems(run.id);
    for (const item of nextRunnable(items)) {
      const claimed = await db
        .update(instanceRestoreApps)
        .set({ status: "restoring", startedAt: new Date(), error: null, updatedAt: new Date() })
        .where(and(eq(instanceRestoreApps.id, item.id), eq(instanceRestoreApps.status, "queued")))
        .returning({ id: instanceRestoreApps.id });
      if (claimed.length === 0) continue;
      const job = restoreApp(item, run.systemBackupAt).finally(() => inFlight.delete(item.id));
      inFlight.set(item.id, job);
    }

    if (inFlight.size === 0 && (await finishIfSettled(run.id))) {
      log.info("Instance restore finished");
      return;
    }
    // Wake on a finished app, or poll for queue changes from the page.
    await Promise.race([sleep(POLL_MS), ...inFlight.values()]);
  }
}

type Item = typeof instanceRestoreApps.$inferSelect;

class AppRestoreError extends Error {}

async function update(item: Item, fields: Partial<Item>): Promise<void> {
  await db
    .update(instanceRestoreApps)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(instanceRestoreApps.id, item.id));
}

/** Restore one app. Every failure stays with this app. */
async function restoreApp(item: Item, at: Date): Promise<void> {
  const lines: string[] = [];
  const note = (msg: string) => lines.push(`[${new Date().toISOString()}] ${msg}`);
  try {
    const members = await db.select().from(apps).where(
      inArray(apps.id, [item.appId, ...(await childIds(item.appId))]),
    );
    const app = members.find((m) => m.id === item.appId);
    if (!app) throw new AppRestoreError("The app is no longer in the restored database");

    await checkHost(members, item.archives, note);

    const files = item.archives.filter((a) => a.strategy === "tar");
    const dumps = item.archives.filter((a) => a.strategy === "dump");

    for (const archive of files) await restoreArchive(archive, at, note);

    if (item.redeploy) {
      await update(item, { status: "deploying" });
      note("Deploying");
      const result = await requestDeploy({ appId: app.id, organizationId: app.organizationId, trigger: "api" });
      if (!result.success) {
        throw new AppRestoreError(`Deploy ${result.status}: ${result.error ?? "see the deployment log"}`);
      }
      note("Deployed");
    } else {
      note("Left stopped, as it was in the backup");
    }

    if (dumps.length > 0 && !item.redeploy) {
      throw new AppRestoreError("Its database dump needs the app running. Start it, then restore the dump from its Backups tab.");
    }
    for (const archive of dumps) await restoreArchive(archive, at, note);

    await update(item, { status: "done", finishedAt: new Date(), log: lines.join("\n") });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note(`Failed: ${message}`);
    log.warn(`Restore of ${item.appName} failed: ${message}`);
    await update(item, { status: "failed", error: message, finishedAt: new Date(), log: lines.join("\n") }).catch(
      () => {},
    );
  }
}

async function childIds(appId: string): Promise<string[]> {
  const rows = await db.select({ id: apps.id }).from(apps).where(eq(apps.parentAppId, appId));
  return rows.map((r) => r.id);
}

/** Fail the app when this host can't run it: no GPU, or a bind source with no archive to recreate it. */
async function checkHost(
  members: (typeof apps.$inferSelect)[],
  archives: RestoreArchivePlan[],
  note: (msg: string) => void,
): Promise<void> {
  if (members.some((m) => m.gpuEnabled) && !(await hostHasNvidia())) {
    throw new AppRestoreError("It needs a GPU and this host has no NVIDIA runtime");
  }

  const binds = await db
    .select({ appId: volumes.appId, name: volumes.name, source: volumes.source })
    .from(volumes)
    .where(and(inArray(volumes.appId, members.map((m) => m.id)), eq(volumes.type, "bind")));
  for (const bind of binds) {
    if (!bind.source) continue;
    const restored = archives.some((a) => a.appId === bind.appId && a.volumeName === bind.name);
    if (restored) continue;
    if (!(await hostPathExists(bind.source))) {
      throw new AppRestoreError(`Bind source ${bind.source} doesn't exist on this host`);
    }
  }
  note("Host has what the app needs");
}

async function hostHasNvidia(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("docker", ["info", "--format", "{{json .Runtimes}}"], { env: dockerEnv(), timeout: 10_000 });
    return String(stdout).includes("nvidia");
  } catch {
    return false;
  }
}

/** Checked through the daemon: this process sees its own filesystem, not the host's. */
async function hostPathExists(path: string): Promise<boolean> {
  try {
    await execFileAsync(
      "docker",
      ["run", "--rm", "--mount", `type=bind,source=${path},target=/probe,readonly`, "alpine", "true"],
      { env: dockerEnv(), timeout: 60_000 },
    );
    return true;
  } catch {
    return false;
  }
}

const MISSING = "missing from storage";

/** Restore the planned archive, falling back to older ones at or before `at` when it's gone from the bucket. */
async function restoreArchive(archive: RestoreArchivePlan, at: Date, note: (msg: string) => void): Promise<void> {
  const label = `${archive.appName}/${archive.volumeName}`;
  const candidates = [archive.backupId];
  let lastError = "";

  for (let i = 0; i < candidates.length; i++) {
    note(`Restoring ${label} from ${i === 0 ? archive.finishedAt : "an older archive"}`);
    const result = await restoreBackup(candidates[i]);
    if (result.success) {
      note(`Restored ${label}`);
      return;
    }
    lastError =
      result.log
        .split("\n")
        .reverse()
        .find((l) => l.includes("Restore failed:"))
        ?.replace(/^\[[^\]]+\] Restore failed: /, "") ?? "restore failed";
    if (!lastError.includes(MISSING)) break;
    if (candidates.length === 1) {
      const older = await olderArchives(archive, at);
      candidates.push(...older);
    }
  }
  if (lastError.includes(MISSING)) {
    throw new AppRestoreError(
      `${label}: no archive at or before this backup is left in storage. Retention may have removed it; a later system backup has newer ones.`,
    );
  }
  throw new AppRestoreError(`${label}: ${lastError}`);
}

async function olderArchives(archive: RestoreArchivePlan, at: Date): Promise<string[]> {
  const list = (await archivesForApps([archive.appId], at)).get(`${archive.appId}:${archive.volumeName}`) ?? [];
  return list.filter((r) => r.id !== archive.backupId).map((r) => r.id);
}
