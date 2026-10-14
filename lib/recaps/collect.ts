// One app's recap: production deploys, hourly history, storage, backups, scans and updates over its window.

import { and, count, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { activities, alertHistory, appSecurityScans, apps, backupJobApps, backups, deployments, environments, volumes } from "@/lib/db/schema";
import type { AppRecap } from "@/lib/bus/events";
import type { StageTimings } from "@/lib/docker/stage-timings";
import { dailySeries, hourOfDay, loadHistoryRows, summarizeHours } from "@/lib/metrics/history";
import { isBackupSelected } from "@/lib/backups/durability";
import { describeSchedule } from "@/lib/cron/describe";
import { addZonedDays, startOfZonedDay, zonedDateKey } from "@/lib/time-zone";
import { logger } from "@/lib/logger";
import { NEAR_LIMIT } from "@/lib/email/templates/app-recap";
import { RECAP_AGE_MS, type RecapKind } from "./schedule";

const log = logger.child("recaps");

export type DeployRow = { status: string; startedAt: Date; stageTimings: StageTimings | null };

const buildMs = (t: StageTimings | null) => (t?.build?.ms ?? 0) + (t?.export?.ms ?? 0);
const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

/** Local day starts from `since` up to `until`. */
export function localDays(since: Date, until: Date, tz: string): string[] {
  const out: string[] = [];
  for (let d = startOfZonedDay(since, tz); d < until; d = addZonedDays(d, 1, tz)) out.push(zonedDateKey(d, tz));
  return out;
}

/** Counts, per-day columns and build times from production deploys in the window. */
export function deployFacts(
  rows: DeployRow[],
  opts: { kind: RecapKind; deployedAt: Date; since: Date; until: Date; tz: string },
): Pick<AppRecap, "deploys" | "deploysByDay" | "build"> {
  const done = rows.filter((r) => r.status === "success" || r.status === "failed");
  const failed = done.filter((r) => r.status === "failed").length;
  const builds = done.filter((r) => r.status === "success" && buildMs(r.stageTimings) > 0);
  let build: AppRecap["build"] = null;
  if (builds.length) {
    const ms = builds.map((r) => buildMs(r.stageTimings));
    build = { avgMs: mean(ms), fastestMs: Math.min(...ms) };
    if (opts.kind === "30d") {
      const earlyEnd = opts.deployedAt.getTime() + RECAP_AGE_MS["72h"];
      const early = builds.filter((r) => r.startedAt.getTime() < earlyEnd).map((r) => buildMs(r.stageTimings));
      if (early.length && early.length < builds.length) build.earlyAvgMs = mean(early);
    }
  }
  const out: Pick<AppRecap, "deploys" | "deploysByDay" | "build"> = { deploys: { total: done.length, failed }, build };
  if (opts.kind === "30d") {
    const days = new Map(localDays(opts.since, opts.until, opts.tz).map((d) => [d, { succeeded: 0, failed: 0 }]));
    for (const r of done) {
      const bucket = days.get(zonedDateKey(r.startedAt, opts.tz));
      if (bucket) bucket[r.status === "failed" ? "failed" : "succeeded"]++;
    }
    out.deploysByDay = [...days.values()];
  }
  return out;
}

/** One state per local day: a success ran, only failures, or nothing. */
export function backupNights(rows: { status: string; startedAt: Date }[], since: Date, until: Date, tz: string): ("ok" | "fail" | "none")[] {
  const byDay = new Map<string, "ok" | "fail">();
  for (const r of rows) {
    const key = zonedDateKey(r.startedAt, tz);
    if (r.status === "success") byDay.set(key, "ok");
    else if (r.status === "failed" && !byDay.has(key)) byDay.set(key, "fail");
  }
  return localDays(since, until, tz).map((d) => byDay.get(d) ?? "none");
}

/** "Nightly at 02:00", "Daily at 03:00". */
function scheduleLabel(job: { schedule: string; nightly: boolean }): string {
  const text = describeSchedule(job.schedule);
  const label = job.nightly ? text.replace(/^daily/, "nightly") : text;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Docker volume names that hold a Vardo volume: its source, or a compose prefix before its name. */
function sizeOf(vol: { name: string; source: string | null }, sizes: Map<string, number>, owned: string[]): number | null {
  let best: number | null = null;
  for (const name of owned) {
    if (name !== vol.source && !name.endsWith(`_${vol.name}`)) continue;
    const size = sizes.get(name);
    if (size !== undefined) best = Math.max(best ?? 0, size);
  }
  return best;
}

async function storage(app: { id: string; name: string; parentAppId: string | null }, sizes: Map<string, number>): Promise<AppRecap["volumes"]> {
  const rows = await db.query.volumes.findMany({
    where: and(eq(volumes.appId, app.id), isNull(volumes.removedAt)),
    columns: { name: true, source: true, persistent: true, durability: true, backupSelection: true },
  });
  if (!rows.length) return [];
  const { findAppData } = await import("@/lib/docker/app-data");
  const owned = await findAppData(app).then((d) => d.volumes.map((v) => v.name)).catch(() => []);
  const backedUp = new Set(
    (
      await db
        .selectDistinct({ volumeName: backups.volumeName })
        .from(backups)
        .where(and(eq(backups.appId, app.id), eq(backups.status, "success")))
    ).map((r) => r.volumeName),
  );
  return rows.map((v) => ({
    name: v.name,
    sizeBytes: sizeOf(v, sizes, owned),
    unprotected: isBackupSelected(v) && !backedUp.has(v.name),
  }));
}

async function seen(appId: string): Promise<{ ports: string[]; processes: string[] }> {
  try {
    const { readSeen } = await import("@/lib/anomaly/store");
    const [ports, procs] = await Promise.all([readSeen(appId, "ports"), readSeen(appId, "procs")]);
    return { ports: [...ports.keys()].sort(), processes: [...procs.keys()].sort() };
  } catch {
    return { ports: [], processes: [] };
  }
}

async function imageUpdateCount(orgId: string, appId: string): Promise<number> {
  try {
    const { isFeatureEnabledAsync } = await import("@/lib/config/features");
    if (!(await isFeatureEnabledAsync("image-updates"))) return 0;
    const { getAggregateUpdateStatus } = await import("@/lib/docker/image-updates/status");
    const { getCooldownUntil } = await import("@/lib/docker/image-updates/check");
    const rows = await db
      .select({
        id: apps.id,
        name: apps.name,
        displayName: apps.displayName,
        deployType: apps.deployType,
        imageName: apps.imageName,
        composeContent: apps.composeContent,
        composeService: apps.composeService,
        isSystemManaged: apps.isSystemManaged,
      })
      .from(apps)
      .where(eq(apps.id, appId));
    const status = await getAggregateUpdateStatus(orgId, rows, await getCooldownUntil());
    return status.appsWithUpdates.find((a) => a.id === appId)?.count ?? 0;
  } catch (err) {
    log.warn(`Image updates for ${appId} unread: ${err instanceof Error ? err.message : err}`);
    return 0;
  }
}

/** The host's Docker volume sizes, read once per pass. Empty when Docker doesn't answer in time. */
export async function volumeSizes(): Promise<Map<string, number>> {
  try {
    const { getVolumeSizes } = await import("@/lib/docker/client");
    const { within, VOLUME_SIZES_TIMEOUT_MS } = await import("@/lib/docker/app-data");
    return await within(getVolumeSizes({ timeoutMs: VOLUME_SIZES_TIMEOUT_MS }), VOLUME_SIZES_TIMEOUT_MS, new Map<string, number>());
  } catch {
    return new Map();
  }
}

export type RecapTarget = {
  appId: string;
  organizationId: string;
  kind: RecapKind;
  deployedAt: Date;
};

/** Everything one recap shows. `sizes` is the host's volume sizes, read once per pass. */
export async function collectRecap(target: RecapTarget, now: Date, tz: string, sizes: Map<string, number>): Promise<AppRecap | null> {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, target.appId),
    columns: { id: true, name: true, displayName: true, projectId: true, parentAppId: true },
    with: { project: { columns: { id: true, displayName: true, name: true } } },
  });
  if (!app) return null;
  const since = target.deployedAt;
  const window = { from: since, to: now };
  const inWindow = (column: AnyPgColumn) => and(gte(column, since), lt(column, now));

  const [deployRows, historyRows, crashes, ooms, scan, job, lastBackup, backupRows, volumeRows, ports, updates] = await Promise.all([
    db
      .select({ status: deployments.status, startedAt: deployments.startedAt, stageTimings: deployments.stageTimings, envType: environments.type })
      .from(deployments)
      .leftJoin(environments, eq(environments.id, deployments.environmentId))
      .where(and(eq(deployments.appId, app.id), isNull(deployments.groupEnvironmentId), inWindow(deployments.startedAt))),
    loadHistoryRows(target.organizationId, window, [app.id]),
    db.select({ n: count() }).from(activities).where(and(eq(activities.appId, app.id), eq(activities.action, "app.crashed"), inWindow(activities.createdAt))),
    db
      .select({ n: count() })
      .from(alertHistory)
      .where(and(eq(alertHistory.organizationId, target.organizationId), eq(alertHistory.type, "app.oom"), eq(alertHistory.about, app.id), inWindow(alertHistory.firedAt))),
    db.query.appSecurityScans.findFirst({
      where: and(eq(appSecurityScans.appId, app.id), eq(appSecurityScans.status, "completed")),
      orderBy: [desc(appSecurityScans.startedAt)],
      columns: { criticalCount: true, warningCount: true },
    }),
    db.query.backupJobApps.findMany({
      where: eq(backupJobApps.appId, app.id),
      with: { backupJob: { columns: { schedule: true, nightly: true, enabled: true } } },
    }),
    db.query.backups.findFirst({
      where: and(eq(backups.appId, app.id), eq(backups.status, "success")),
      orderBy: [desc(backups.startedAt)],
      columns: { finishedAt: true, startedAt: true },
    }),
    target.kind === "30d"
      ? db.select({ status: backups.status, startedAt: backups.startedAt }).from(backups).where(and(eq(backups.appId, app.id), inArray(backups.status, ["success", "failed"]), inWindow(backups.startedAt)))
      : Promise.resolve([]),
    storage(app, sizes),
    seen(app.id),
    target.kind === "30d" ? imageUpdateCount(target.organizationId, app.id) : Promise.resolve(undefined),
  ]);

  const production = deployRows.filter((r) => (r.envType ?? "production") === "production");
  const summary = summarizeHours(historyRows, window);
  const memoryLimit = summary.memory?.limit ?? null;
  const daysNearLimit = memoryLimit
    ? dailySeries(historyRows, window, tz).filter((d) => d.memoryPeak !== null && d.memoryPeak >= memoryLimit * NEAR_LIMIT).length
    : 0;
  const hours = hourOfDay(historyRows, window, tz).map((h) =>
    summary.network ? (h.rxBytes ?? 0) + (h.txBytes ?? 0) : (h.cpuAvg ?? 0),
  );
  const activeJob = job.map((j) => j.backupJob).find((j) => j.enabled);

  return {
    appId: app.id,
    appName: app.displayName || app.name,
    projectId: app.project?.id,
    projectName: app.project ? app.project.displayName || app.project.name : undefined,
    kind: target.kind,
    deployedAt: since.toISOString(),
    since: since.toISOString(),
    until: now.toISOString(),
    ...deployFacts(production, { kind: target.kind, deployedAt: since, since, until: now, tz }),
    uptime: summary.uptime
      ? { ratio: summary.uptime.ratio, downMinutes: Math.round((1 - summary.uptime.ratio) * summary.uptime.hoursChecked * 60) }
      : null,
    crashes: crashes[0]?.n ?? 0,
    oomKills: ooms[0]?.n ?? 0,
    cpu: summary.cpu ? { avg: summary.cpu.avg, peak: summary.cpu.peak.value } : null,
    memory: summary.memory
      ? { avg: summary.memory.avg, peak: summary.memory.peak.value, peakAt: summary.memory.peak.at.toISOString(), limit: memoryLimit, daysNearLimit }
      : null,
    network: summary.network ? { rx: summary.network.rxBytes, tx: summary.network.txBytes } : null,
    hours,
    volumes: volumeRows,
    ...ports,
    backups: activeJob
      ? {
          schedule: scheduleLabel(activeJob),
          lastAt: (lastBackup?.finishedAt ?? lastBackup?.startedAt)?.toISOString(),
          ...(target.kind === "30d" ? { nights: backupNights(backupRows, since, now, tz) } : {}),
        }
      : null,
    scanFindings: (scan?.criticalCount ?? 0) + (scan?.warningCount ?? 0),
    ...(updates !== undefined ? { imageUpdates: updates } : {}),
  };
}
