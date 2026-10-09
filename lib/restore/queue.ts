// The app queue of a whole-instance restore, kept in the database so it survives reloads and restarts.

import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { apps, backupJobs, backups, cronJobs } from "@/lib/db/schema";
import {
  instanceRestoreApps,
  instanceRestores,
  type RestoreAppStatus,
  type RestoreArchivePlan,
} from "@/lib/db/schema/restore";
import { isVardoManagedApp } from "@/lib/infra/instance-apps";
import { isSelfApp } from "@/lib/docker/self-env";
import { formatFromArchiveName } from "@/lib/backups/archive-name";
import {
  BUILD_WEIGHT,
  PULL_WEIGHT,
  archivesAsOf,
  moveToFront,
  orderQueue,
  progressOf,
  type ArchiveRow,
} from "./plan";

const BUILD_TYPES = new Set(["dockerfile", "nixpacks", "railpack", "static"]);

type AppRow = typeof apps.$inferSelect;

/** Archive rows for these apps at or before `at`, newest first per volume. */
export async function archivesForApps(appIds: string[], at: Date): Promise<Map<string, ArchiveRow[]>> {
  if (appIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: backups.id,
      appId: backups.appId,
      appName: backups.appName,
      volumeName: backups.volumeName,
      strategy: backups.strategy,
      storagePath: backups.storagePath,
      finishedAt: backups.finishedAt,
    })
    .from(backups)
    .where(and(eq(backups.status, "success"), inArray(backups.appId, appIds), isNotNull(backups.finishedAt)));

  return archivesAsOf(
    rows
      .filter((r) => r.appId && r.volumeName && r.finishedAt && r.storagePath)
      .map((r) => ({
        id: r.id,
        appId: r.appId!,
        appName: r.appName ?? "",
        volumeName: r.volumeName!,
        strategy: r.strategy === "dump" || formatFromArchiveName(r.storagePath!) === "dump" ? "dump" : "tar",
        finishedAt: r.finishedAt!,
      })),
    at,
  );
}

/** Queue every user app with its archives as of the system backup. */
export async function buildRestoreQueue(restoreId: string, at: Date): Promise<void> {
  const all = await db.select().from(apps);
  const children = new Map<string, AppRow[]>();
  for (const app of all) {
    if (!app.parentAppId) continue;
    children.set(app.parentAppId, [...(children.get(app.parentAppId) ?? []), app]);
  }
  const units = all.filter((a) => !a.parentAppId && !isVardoManagedApp(a) && !isSelfApp(a.name));
  if (units.length === 0) return;

  const memberIds = units.flatMap((u) => [u.id, ...(children.get(u.id) ?? []).map((c) => c.id)]);
  const archives = await archivesForApps(memberIds, at);

  const order = orderQueue(
    units.map((u) => ({
      appId: u.id,
      name: u.name,
      projectId: u.projectId,
      priority: u.priority ?? "standard",
      dependsOn: u.dependsOn ?? [],
    })),
  );
  const byId = new Map(units.map((u) => [u.id, u]));

  await db.insert(instanceRestoreApps).values(
    order.map(({ appId, position, dependsOn }) => {
      const app = byId.get(appId)!;
      const members = [app, ...(children.get(app.id) ?? [])];
      const plan: RestoreArchivePlan[] = [];
      for (const [key, list] of archives) {
        if (!members.some((m) => key.startsWith(`${m.id}:`))) continue;
        const newest = list[0];
        plan.push({
          backupId: newest.id,
          appId: newest.appId,
          appName: newest.appName,
          volumeName: newest.volumeName,
          strategy: newest.strategy,
          finishedAt: newest.finishedAt.toISOString(),
        });
      }
      return {
        id: nanoid(),
        restoreId,
        appId,
        appName: app.name,
        organizationId: app.organizationId,
        priority: app.priority ?? "standard",
        weight: BUILD_TYPES.has(app.deployType) ? BUILD_WEIGHT : PULL_WEIGHT,
        position,
        dependsOn,
        redeploy: app.status !== "stopped" && app.status !== "missing",
        archives: plan,
      };
    }),
  );
}

/** The newest run, or null. */
export async function currentRestore() {
  return (await db.query.instanceRestores.findFirst({ orderBy: desc(instanceRestores.startedAt) })) ?? null;
}

export async function restoreItems(restoreId: string) {
  return db
    .select()
    .from(instanceRestoreApps)
    .where(eq(instanceRestoreApps.restoreId, restoreId))
    .orderBy(instanceRestoreApps.position);
}

export type RestoreView = Awaited<ReturnType<typeof restoreView>>;

/** What the progress page shows. */
export async function restoreView(restoreId: string) {
  const run = await db.query.instanceRestores.findFirst({ where: eq(instanceRestores.id, restoreId) });
  if (!run) return null;
  const items = await restoreItems(restoreId);
  return {
    id: run.id,
    status: run.status,
    systemBackupKey: run.systemBackupKey,
    systemBackupAt: run.systemBackupAt.toISOString(),
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    resumedAt: run.resumedAt?.toISOString() ?? null,
    pausedBackupJobs: run.pausedBackupJobIds.length,
    pausedCronJobs: run.pausedCronJobIds.length,
    progress: progressOf(items),
    apps: items.map((i) => ({
      appId: i.appId,
      name: i.appName,
      priority: i.priority,
      status: i.status,
      weight: i.weight,
      redeploy: i.redeploy,
      archives: i.archives,
      error: i.error,
      startedAt: i.startedAt?.toISOString() ?? null,
      finishedAt: i.finishedAt?.toISOString() ?? null,
    })),
  };
}

async function setPositions(restoreId: string, positions: Map<string, number>): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [appId, position] of positions) {
      await tx
        .update(instanceRestoreApps)
        .set({ position })
        .where(and(eq(instanceRestoreApps.restoreId, restoreId), eq(instanceRestoreApps.appId, appId)));
    }
  });
}

/** Move a queued app, and anything it waits on, to the front. */
export async function moveAppToFront(restoreId: string, appId: string): Promise<boolean> {
  const items = await restoreItems(restoreId);
  const item = items.find((i) => i.appId === appId);
  if (!item || (item.status !== "queued" && item.status !== "deferred")) return false;
  if (item.status === "deferred") await setItemStatus(restoreId, appId, "deferred", "queued");
  const refreshed = await restoreItems(restoreId);
  await setPositions(restoreId, moveToFront(refreshed, appId));
  return true;
}

/** Queue a failed app again, at the front. */
export async function retryApp(restoreId: string, appId: string): Promise<boolean> {
  if (!(await setItemStatus(restoreId, appId, "failed", "queued"))) return false;
  await setPositions(restoreId, moveToFront(await restoreItems(restoreId), appId));
  return true;
}

/** Leave an app defined but stopped, or put a deferred one back in the queue. */
export async function deferApp(restoreId: string, appId: string, defer: boolean): Promise<boolean> {
  return defer
    ? setItemStatus(restoreId, appId, "queued", "deferred")
    : setItemStatus(restoreId, appId, "deferred", "queued");
}

async function setItemStatus(
  restoreId: string,
  appId: string,
  from: RestoreAppStatus,
  to: RestoreAppStatus,
): Promise<boolean> {
  const updated = await db
    .update(instanceRestoreApps)
    .set({ status: to, updatedAt: new Date() })
    .where(
      and(
        eq(instanceRestoreApps.restoreId, restoreId),
        eq(instanceRestoreApps.appId, appId),
        eq(instanceRestoreApps.status, from),
      ),
    )
    .returning({ id: instanceRestoreApps.id });
  return updated.length > 0;
}

/** Turn back on the backup and cron jobs this restore paused. */
export async function resumeScheduledJobs(restoreId: string): Promise<{ backups: number; crons: number }> {
  const run = await db.query.instanceRestores.findFirst({ where: eq(instanceRestores.id, restoreId) });
  if (!run || run.resumedAt) return { backups: 0, crons: 0 };
  const now = new Date();
  const resumedBackups = run.pausedBackupJobIds.length
    ? await db
        .update(backupJobs)
        .set({ enabled: true, updatedAt: now })
        .where(inArray(backupJobs.id, run.pausedBackupJobIds))
        .returning({ id: backupJobs.id })
    : [];
  const resumedCrons = run.pausedCronJobIds.length
    ? await db
        .update(cronJobs)
        .set({ enabled: true })
        .where(inArray(cronJobs.id, run.pausedCronJobIds))
        .returning({ id: cronJobs.id })
    : [];
  await db.update(instanceRestores).set({ resumedAt: now }).where(eq(instanceRestores.id, restoreId));
  return { backups: resumedBackups.length, crons: resumedCrons.length };
}

/** Put apps that were mid-flight when the process stopped back in the queue. */
export async function requeueInterrupted(restoreId: string): Promise<number> {
  const updated = await db
    .update(instanceRestoreApps)
    .set({ status: "queued", error: "Vardo restarted while this app was restoring, so it starts again", updatedAt: new Date() })
    .where(
      and(
        eq(instanceRestoreApps.restoreId, restoreId),
        inArray(instanceRestoreApps.status, ["restoring", "deploying"]),
      ),
    )
    .returning({ id: instanceRestoreApps.id });
  return updated.length;
}

/** Mark the run finished once nothing is queued or in flight. */
export async function finishIfSettled(restoreId: string): Promise<boolean> {
  const pending = await db
    .select({ id: instanceRestoreApps.id })
    .from(instanceRestoreApps)
    .where(
      and(
        eq(instanceRestoreApps.restoreId, restoreId),
        inArray(instanceRestoreApps.status, ["queued", "restoring", "deploying"]),
      ),
    )
    .limit(1);
  if (pending.length > 0) return false;
  await db
    .update(instanceRestores)
    .set({ status: "finished", finishedAt: new Date() })
    .where(and(eq(instanceRestores.id, restoreId), ne(instanceRestores.status, "finished")));
  return true;
}
