// Reads what the Pipeline snapshot needs: deploy rows, the build gate in Redis, targets, jobs, loops and recent events.

import { and, desc, eq, gt, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, backupJobs, backups, cronJobRuns, cronJobs, deployments, organizations } from "@/lib/db/schema";
import { failureFromLog } from "@/lib/stream/deploy-tail";
import { getNextRun } from "@/lib/backups/next-run";
import { overdueBackupJobs } from "@/lib/backups/staleness";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { BUILD_GATE_KEYS, localBuildLimit } from "@/lib/docker/build-gate";
import { configuredTargets } from "@/lib/docker/build-targets";
import { maxDeployConcurrency } from "@/lib/resources/host";
import { getInstanceDisplayName } from "@/lib/system-settings";
import { backupWorkInFlight, otherBackupWork } from "@/lib/backups/in-flight";
import { readLoopStatus } from "@/lib/worker/status";
import { PIPELINE_STREAM, parsePipelineEntry, type PipelineEntry } from "./events";
import {
  assembleSnapshot,
  toPipelineDeploy,
  type DeployContext,
  type BackupRow,
  type CronRow,
  type DeployRow,
  type DrillRow,
  type GateState,
  type TargetConfig,
} from "./snapshot";
import { pipelineMedians, type PipelineMedians } from "./medians";
import type { PipelineDeploy, PipelineSnapshot, PipelineTotals, ScheduledJob } from "./types";

const log = logger.child("pipeline");

/** Finished work stays on the map this long, so it reaches its last stop. */
export const LINGER_MS = 30_000;
const EVENT_COUNT = 300;
const CACHE_MS = 15_000;

let targetsCache: { at: number; value: TargetConfig[] } | null = null;
let limitCache: { at: number; value: number } | null = null;

async function cached<T>(slot: { at: number; value: T } | null, load: () => Promise<T>, fallback: T, set: (v: { at: number; value: T }) => void): Promise<T> {
  if (slot && Date.now() - slot.at < CACHE_MS) return slot.value;
  const value = await load().catch((err) => {
    log.warn("Pipeline read failed:", err instanceof Error ? err.message : err);
    return slot?.value ?? fallback;
  });
  set({ at: Date.now(), value });
  return value;
}

export const readTargets = () =>
  cached(
    targetsCache,
    async () => (await configuredTargets()).map((t): TargetConfig => ({ id: t.id, name: t.name, kind: t.kind, maxConcurrent: t.maxConcurrent })),
    [],
    (v) => (targetsCache = v),
  );

const readLocalSlots = () => cached(limitCache, localBuildLimit, 1, (v) => (limitCache = v));

const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

const deployColumns = {
  id: deployments.id,
  appId: deployments.appId,
  appName: apps.displayName,
  status: deployments.status,
  stage: deployments.stage,
  waitReason: deployments.waitReason,
  waitingSince: deployments.waitingSince,
  waitAhead: deployments.waitAhead,
  waitTotal: deployments.waitTotal,
  waitEta: deployments.waitEta,
  startedAt: deployments.startedAt,
  claimedAt: deployments.claimedAt,
  finishedAt: deployments.finishedAt,
  buildOutcome: deployments.buildOutcome,
  buildTargetId: deployments.buildTargetId,
  buildTargetName: deployments.buildTargetName,
  claimSlot: deployments.claimSlot,
  timings: deployments.stageTimings,
  imageTransfer: deployments.imageTransfer,
  imageTransferMs: deployments.imageTransferMs,
  appSlug: apps.name,
  orgName: organizations.name,
  trigger: deployments.trigger,
  logTail: sql<string | null>`case when ${deployments.status} in ('failed', 'rolled_back') then right(${deployments.log}, 4000) end`,
};

type DeploySelect = { [K in Exclude<keyof typeof deployColumns, "logTail">]: (typeof deployColumns)[K]["_"]["data"] | null } & {
  logTail: string | null;
};

export const toRow = (r: DeploySelect): DeployRow => ({
  id: r.id!,
  appId: r.appId!,
  appName: r.appName!,
  status: r.status!,
  stage: r.stage,
  waitReason: r.waitReason,
  waitingSince: time(r.waitingSince),
  waitAhead: r.waitAhead,
  waitTotal: r.waitTotal,
  waitEta: time(r.waitEta),
  queuedAt: time(r.startedAt)!,
  claimedAt: time(r.claimedAt),
  finishedAt: time(r.finishedAt),
  buildOutcome: r.buildOutcome,
  buildTargetId: r.buildTargetId,
  buildTargetName: r.buildTargetName,
  claimSlot: r.claimSlot,
  timings: r.timings,
  imageTransfer: r.imageTransfer,
  imageTransferMs: r.imageTransferMs,
  appSlug: r.appSlug,
  orgName: r.orgName,
  trigger: r.trigger,
  failure: failureFromLog(r.logTail) ?? null,
});

/** Deploy rows with their app and org. */
export const deployFrom = () =>
  db
    .select(deployColumns)
    .from(deployments)
    .innerJoin(apps, eq(apps.id, deployments.appId))
    .leftJoin(organizations, eq(organizations.id, apps.organizationId));

/** Finished deploys before the linger, within the hour, newest first. */
export const RECENT_MS = 60 * 60_000;
const RECENT_LIMIT = 50;

async function readRecent(now: number, windowMs = RECENT_MS, limit = RECENT_LIMIT): Promise<DeployRow[]> {
  const rows = await deployFrom()
    .where(
      and(
        Number.isFinite(windowMs) ? gt(deployments.finishedAt, new Date(now - windowMs)) : isNotNull(deployments.finishedAt),
        lte(deployments.finishedAt, new Date(now - LINGER_MS)),
      ),
    )
    .orderBy(desc(deployments.finishedAt))
    .limit(limit);
  return rows.map(toRow);
}

/** At least this many finished deploys, however old, so a quiet page still shows the last ones. */
const RECENT_FLOOR = 5;

async function readRecentOrLast(now: number): Promise<DeployRow[]> {
  const hour = await readRecent(now);
  return hour.length >= RECENT_FLOOR ? hour : readRecent(now, Infinity, RECENT_FLOOR);
}

/** History windows the Pipeline page fetches on demand. */
export const HISTORY_WINDOWS = { "1h": 60 * 60_000, "6h": 6 * 60 * 60_000 } as const;
export type HistoryWindow = keyof typeof HISTORY_WINDOWS;
const HISTORY_LIMIT = 300;

/** Deploys finished in the window, newest first, with their apps' medians. */
export async function readPipelineHistory(window: HistoryWindow): Promise<Pick<PipelineSnapshot, "recent" | "medians">> {
  const now = Date.now();
  const [targets, rows, medians] = await Promise.all([
    readTargets(),
    readRecent(now, HISTORY_WINDOWS[window], HISTORY_LIMIT),
    soft(pipelineMedians(now), { apps: {}, builders: {} }, "stage medians"),
  ]);
  const ctx: DeployContext = {
    now,
    builderName: new Map<string, string>([["local", (await soft(getInstanceDisplayName(), null, "the instance name")) ?? "This server"], ...targets.map((t): [string, string] => [t.id, t.name])]),
    holding: new Map(),
    stageAt: new Map(),
    fellBack: new Set(),
  };
  const recent = rows.map((r) => toPipelineDeploy(r, ctx));
  const ids = new Set(recent.map((d) => d.appId));
  return { recent, medians: { apps: Object.fromEntries(Object.entries(medians.apps).filter(([id]) => ids.has(id))), builders: medians.builders } };
}

async function readDeploys(now: number): Promise<DeployRow[]> {
  const rows = await deployFrom()
    .where(
      or(
        inArray(deployments.status, ["queued", "running"]),
        and(isNotNull(deployments.finishedAt), gt(deployments.finishedAt, new Date(now - LINGER_MS))),
      ),
    )
    .orderBy(deployments.startedAt)
    .limit(100);
  return rows.map(toRow);
}

async function readGate(targets: TargetConfig[]): Promise<GateState> {
  const keys = BUILD_GATE_KEYS;
  const now = Date.now();
  const multi = redis.multi().zrangebyscore(keys.running, now, "+inf").hgetall(keys.started).get(keys.ready);
  for (const t of targets) multi.zrangebyscore(keys.target + t.id, now, "+inf");
  const results = (await multi.exec()) ?? [];
  const value = (i: number) => {
    const [err, v] = results[i] ?? [null, null];
    if (err) throw err;
    return v;
  };
  const started = (value(1) ?? {}) as Record<string, string>;
  const ready = value(2) as string | null;
  return {
    local: ((value(0) ?? []) as string[])
      .map((token) => ({ token, since: started[token] ? Number(started[token]) : null }))
      .sort((a, b) => (a.since ?? 0) - (b.since ?? 0)),
    targets: Object.fromEntries(targets.map((t, i) => [t.id, (value(3 + i) ?? []) as string[]])),
    ready: ready ? (JSON.parse(ready) as { id: string }[]).map((t) => t.id) : null,
  };
}

async function readEvents(): Promise<PipelineEntry[]> {
  const raw = (await redis.xrevrange(PIPELINE_STREAM, "+", "-", "COUNT", EVENT_COUNT)) as [string, string[]][];
  return raw.flatMap(([, fields]) => {
    const record: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) record[fields[i]] = fields[i + 1];
    const entry = parsePipelineEntry(record);
    return entry ? [entry] : [];
  });
}

async function readBackups(now: number, verifying: Set<string>): Promise<BackupRow[]> {
  const rows = await db
    .select({
      id: backups.id,
      appName: backups.appName,
      volumeName: backups.volumeName,
      jobName: backups.jobName,
      status: backups.status,
      startedAt: backups.startedAt,
      finishedAt: backups.finishedAt,
    })
    .from(backups)
    .where(or(eq(backups.status, "running"), and(isNotNull(backups.finishedAt), gt(backups.finishedAt, new Date(now - LINGER_MS)))))
    .orderBy(backups.startedAt)
    .limit(30);
  return rows.map((r) => ({
    id: r.id,
    name: [r.appName ?? "System", r.volumeName].filter(Boolean).join(" · "),
    status: r.status,
    startedAt: time(r.startedAt)!,
    finishedAt: r.status === "running" ? null : time(r.finishedAt),
    verifying: verifying.has(r.id),
  }));
}

/** Drill work strings from every process's busy beacon, as "drill of backup <id>". */
async function readDrillIds(): Promise<Set<string>> {
  const work = [
    ...backupWorkInFlight().map((w) => `${w.kind} ${w.label}`),
    ...(await otherBackupWork(null).catch(() => [])).map((o) => o.work),
  ].join(", ");
  return new Set([...work.matchAll(/drill of backup ([\w-]+)/g)].map((m) => m[1]));
}

async function readDrills(now: number, running: Set<string>): Promise<DrillRow[]> {
  const rows = await db
    .select({
      id: backups.id,
      appName: backups.appName,
      volumeName: backups.volumeName,
      startedAt: backups.startedAt,
      verifiedAt: backups.verifiedAt,
      verifyOutcome: backups.verifyOutcome,
    })
    .from(backups)
    .where(
      or(
        running.size > 0 ? inArray(backups.id, [...running]) : sql`false`,
        and(isNotNull(backups.verifiedAt), gt(backups.verifiedAt, new Date(now - LINGER_MS))),
      ),
    )
    .limit(30);
  return rows.map((r) => {
    const live = running.has(r.id);
    return {
      backupId: r.id,
      name: [r.appName ?? "System", r.volumeName].filter(Boolean).join(" · "),
      startedAt: live ? now : (time(r.verifiedAt) ?? now),
      finishedAt: live ? null : time(r.verifiedAt),
      failed: !live && r.verifyOutcome === "failed",
    };
  });
}

async function readCrons(now: number): Promise<CronRow[]> {
  const [running, finished] = await Promise.all([
    db
      .select({ id: cronJobs.id, name: cronJobs.name, appName: apps.displayName, lastRunAt: cronJobs.lastRunAt })
      .from(cronJobs)
      .leftJoin(apps, eq(apps.id, cronJobs.appId))
      .where(eq(cronJobs.lastStatus, "running"))
      .limit(30),
    db
      .select({
        id: cronJobRuns.id,
        name: cronJobs.name,
        appName: apps.displayName,
        startedAt: cronJobRuns.startedAt,
        completedAt: cronJobRuns.completedAt,
        status: cronJobRuns.status,
      })
      .from(cronJobRuns)
      .innerJoin(cronJobs, eq(cronJobs.id, cronJobRuns.cronJobId))
      .leftJoin(apps, eq(apps.id, cronJobs.appId))
      .where(and(isNotNull(cronJobRuns.completedAt), gt(cronJobRuns.completedAt, new Date(now - LINGER_MS))))
      .orderBy(desc(cronJobRuns.completedAt))
      .limit(30),
  ]);
  const label = (app: string | null, name: string) => (app ? `${app} · ${name}` : name);
  return [
    ...running.map((r): CronRow => ({
      id: r.id,
      name: label(r.appName, r.name),
      running: true,
      startedAt: time(r.lastRunAt) ?? now,
      finishedAt: null,
      failed: false,
    })),
    ...finished.map((r): CronRow => ({
      id: r.id,
      name: label(r.appName, r.name),
      running: false,
      startedAt: time(r.startedAt)!,
      finishedAt: time(r.completedAt),
      failed: r.status === "failed",
    })),
  ];
}

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

async function readTotals(now: number): Promise<PipelineTotals> {
  const since = new Date(now - DAY_MS);
  const [[row], hours, [last]] = await Promise.all([
    db
      .select({
        live: sql<number>`count(*) filter (where ${deployments.status} = 'success')`,
        elsewhere: sql<number>`count(*) filter (where ${deployments.buildOutcome} = 'target')`,
        fellBack: sql<number>`count(*) filter (where ${deployments.buildOutcome} = 'fallback')`,
        failed: sql<number>`count(*) filter (where ${deployments.status} in ('failed', 'rolled_back'))`,
        medianToLive: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from ${deployments.finishedAt} - ${deployments.startedAt}) * 1000) filter (where ${deployments.status} = 'success')`,
      })
      .from(deployments)
      .where(gt(deployments.finishedAt, since)),
    db
      .select({ hour: sql<number>`floor(extract(epoch from ${deployments.finishedAt}) / 3600)::int`, n: sql<number>`count(*)::int` })
      .from(deployments)
      .where(and(eq(deployments.status, "success"), gt(deployments.finishedAt, since)))
      .groupBy(sql`1`),
    db.select({ at: sql<Date | null>`max(${deployments.finishedAt})`.mapWith(deployments.finishedAt) }).from(deployments).where(eq(deployments.status, "success")),
  ]);
  const hourly = Array.from({ length: 24 }, () => 0);
  const thisHour = Math.floor(now / HOUR_MS);
  for (const h of hours) {
    const ago = thisHour - Number(h.hour);
    if (ago >= 0 && ago < 24) hourly[23 - ago] = Number(h.n);
  }
  return {
    live: Number(row?.live ?? 0),
    elsewhere: Number(row?.elsewhere ?? 0),
    fellBack: Number(row?.fellBack ?? 0),
    failed: Number(row?.failed ?? 0),
    medianToLiveMs: row?.medianToLive == null ? null : Math.round(Number(row.medianToLive)),
    hourly,
    lastLiveAt: time(last?.at),
  };
}

const UPCOMING_LIMIT = 3;
const SCHEDULE_CACHE_MS = 30_000;
let scheduleCache: { at: number; value: { upcoming: ScheduledJob[]; overdue: ScheduledJob[] } } | null = null;

/** The soonest cron and backup runs, and backup jobs past due. */
async function readSchedules(now: number): Promise<{ upcoming: ScheduledJob[]; overdue: ScheduledJob[] }> {
  if (scheduleCache && now - scheduleCache.at < SCHEDULE_CACHE_MS) return scheduleCache.value;
  const [crons, jobs] = await Promise.all([
    db
      .select({ name: cronJobs.name, appName: apps.displayName, schedule: cronJobs.schedule, timeZone: cronJobs.timeZone })
      .from(cronJobs)
      .leftJoin(apps, eq(apps.id, cronJobs.appId))
      .where(eq(cronJobs.enabled, true))
      .limit(500),
    db
      .select({
        id: backupJobs.id,
        name: backupJobs.name,
        schedule: backupJobs.schedule,
        enabled: backupJobs.enabled,
        lastRunAt: backupJobs.lastRunAt,
        createdAt: backupJobs.createdAt,
        timeZone: organizations.timeZone,
      })
      .from(backupJobs)
      .leftJoin(organizations, eq(organizations.id, backupJobs.organizationId))
      .where(eq(backupJobs.enabled, true))
      .limit(500),
  ]);
  const next = (schedule: string, tz: string | null) => getNextRun(schedule, tz ?? "UTC")?.getTime() ?? null;
  const upcoming = [
    ...crons.map((c) => ({ kind: "cron", name: c.appName ? `${c.appName} · ${c.name}` : c.name, at: next(c.schedule, c.timeZone) })),
    ...jobs.map((j) => ({ kind: "backup", name: j.name, at: next(j.schedule, j.timeZone) })),
  ]
    .flatMap((j): ScheduledJob[] => (j.at === null ? [] : [{ kind: j.kind as ScheduledJob["kind"], name: j.name, at: j.at }]))
    .sort((a, b) => a.at - b.at)
    .slice(0, UPCOMING_LIMIT);
  const overdue = overdueBackupJobs(jobs, new Date(now)).map((o): ScheduledJob => ({ kind: "backup", name: o.job.name, at: o.since.getTime() }));
  const value = { upcoming, overdue };
  scheduleCache = { at: now, value };
  return value;
}

async function readEventApps(events: PipelineEntry[], known: Set<string>): Promise<Record<string, string>> {
  const ids = [...new Set(events.flatMap((e) => ("deploymentId" in e && e.deploymentId && !known.has(e.deploymentId) ? [e.deploymentId] : [])))];
  if (ids.length === 0) return {};
  const rows = await db
    .select({ id: deployments.id, name: apps.displayName })
    .from(deployments)
    .innerJoin(apps, eq(apps.id, deployments.appId))
    .where(inArray(deployments.id, ids.slice(0, 200)));
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

const soft = <T>(p: Promise<T>, fallback: T, what: string): Promise<T> =>
  p.catch((err) => {
    log.warn(`Couldn't read ${what} for the pipeline:`, err instanceof Error ? err.message : err);
    return fallback;
  });

/** The whole page's state now. Parts that can't be read come back empty. */
export async function readPipelineSnapshot(): Promise<PipelineSnapshot> {
  const now = Date.now();
  const targets = await readTargets();
  const drillIds = await soft(readDrillIds(), new Set<string>(), "restore drills");
  const [instanceName, localSlots, gate, deploys, events, backupRows, drills, crons, loops, totals, recent, medians, schedules] = await Promise.all([
    soft(getInstanceDisplayName(), null, "the instance name"),
    readLocalSlots(),
    soft(readGate(targets), { local: [], targets: {}, ready: null }, "the build gate"),
    readDeploys(now),
    soft(readEvents(), [], "pipeline events"),
    soft(readBackups(now, drillIds), [], "backups"),
    soft(readDrills(now, drillIds), [], "restore drills"),
    soft(readCrons(now), [], "cron runs"),
    soft(readLoopStatus().then((r) => r.loops), [], "background loops"),
    soft(readTotals(now), { live: 0, elsewhere: 0, fellBack: 0, failed: 0 }, "deploy totals"),
    soft(readRecentOrLast(now), [], "recent deploys"),
    soft(pipelineMedians(now), { apps: {}, builders: {} }, "stage medians"),
    soft(readSchedules(now), { upcoming: [], overdue: [] }, "job schedules"),
  ]);
  const known = new Set([...deploys, ...recent].map((d) => d.id));
  const eventApps = await soft(readEventApps(events, known), {}, "app names");
  return assembleSnapshot({
    now,
    instanceName: instanceName ?? "This server",
    deploySlots: maxDeployConcurrency(),
    localSlots,
    gate,
    targets,
    deploys,
    backups: backupRows,
    drills,
    crons,
    loops,
    events,
    eventApps,
    totals,
    recent,
    medians,
    ...schedules,
  });
}

/** One deploy as the Pipeline draws it, the app's last good run before it and the app's medians. */
export type DeployTrack = { deploy: PipelineDeploy; previous: PipelineDeploy | null; medians: PipelineMedians };

/** A deploy of `appId` with its likely builder and stage times. Null when the app has no such deploy. */
export async function readDeployTrack(appId: string, deploymentId: string): Promise<DeployTrack | null> {
  const now = Date.now();
  const [found] = await deployFrom()
    .where(and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)))
    .limit(1);
  if (!found) return null;
  const row = toRow(found);
  const targets = await readTargets();
  const [prev, instanceName, localSlots, gate, deploys, events, medians] = await Promise.all([
    deployFrom()
      .where(and(eq(deployments.appId, appId), eq(deployments.status, "success"), lt(deployments.startedAt, new Date(row.queuedAt))))
      .orderBy(desc(deployments.startedAt))
      .limit(1)
      .then((rows) => rows.map(toRow)),
    soft(getInstanceDisplayName(), null, "the instance name"),
    readLocalSlots(),
    soft(readGate(targets), { local: [], targets: {}, ready: null }, "the build gate"),
    readDeploys(now),
    soft(readEvents(), [], "pipeline events"),
    soft(pipelineMedians(now), { apps: {}, builders: {} }, "stage medians"),
  ]);
  const snap = assembleSnapshot({
    now,
    instanceName: instanceName ?? "This server",
    deploySlots: maxDeployConcurrency(),
    localSlots,
    gate,
    targets,
    deploys,
    backups: [],
    drills: [],
    crons: [],
    loops: [],
    events,
    totals: { live: 0, elsewhere: 0, fellBack: 0, failed: 0 },
    recent: [row, ...prev],
    medians,
  });
  const deploy = snap.deploys.find((d) => d.id === row.id) ?? snap.recent.find((d) => d.id === row.id)!;
  const previous = prev[0] ? (snap.recent.find((d) => d.id === prev[0].id) ?? null) : null;
  const own = medians.apps[appId];
  return { deploy, previous, medians: { apps: own ? { [appId]: own } : {}, builders: medians.builders } };
}
