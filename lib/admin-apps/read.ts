// Reads the Apps page: every app on this instance with its live metrics, last 24 hours and one app's drill-in.

import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, backups, cronJobRuns, cronJobs, deployments, incidents, organizations, projects, uptimeHourly, uptimeMonitors } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { tsRedis } from "@/lib/metrics/ts-client";
import { queryHostHistory } from "@/lib/metrics/store-host";
import { detectHost } from "@/lib/resources/host";
import { getInstanceDisplayName } from "@/lib/system-settings";
import { UPTIME_INCIDENT } from "@/lib/incidents/uptime";
import { deployFrom, readTargets, toRow } from "@/lib/pipeline/read";
import { toPipelineDeploy, type DeployContext } from "@/lib/pipeline/snapshot";
import { deploySegments } from "@/lib/pipeline/segments";
import type { StageTimings } from "@/lib/docker/stage-timings";
import {
  bucketSeries,
  counterRates,
  cronMarks,
  drillEvents,
  focusWindow,
  lastDeployOf,
  latest,
  memoryLimitOf,
  mergeSpans,
  pickFocus,
  ribbonDeploy,
  sumSeries,
  uptimeRatio,
  type Point,
} from "./shape";
import type { AppDrill, AppRow, AppsSnapshot, AppsTotals, HostMemory, RibbonDeploy, RibbonSpan } from "./types";

const log = logger.child("admin-apps");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Sparks: the last hour in one-minute steps. */
const SPARK_STEP = MIN;
const SPARK_STEPS = 60;
/** Cron runs are one mark per this much ribbon. */
const CRON_BUCKET = 15 * MIN;
/** Host memory tile: six hours in five-minute steps. */
const HOST_STEP = 5 * MIN;
const HOST_STEPS = 72;
/** Database reads are shared by every poll this long. */
const CACHE_MS = 10_000;

const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

const soft = <T>(p: Promise<T>, fallback: T, what: string): Promise<T> =>
  p.catch((err) => {
    log.warn(`Couldn't read ${what}:`, err instanceof Error ? err.message : err);
    return fallback;
  });

// ---- Time series --------------------------------------------------------------

type Series = { project: string; org: string | null; points: Point[] };

/** One metric for every container, per container, aggregated into `stepMs` buckets. */
async function rangeByContainer(metric: string, from: number, to: number, agg: "avg" | "last", stepMs: number, filters: string[] = []): Promise<Series[]> {
  let result: unknown;
  try {
    result = await tsRedis.call(
      "TS.MRANGE", String(from), String(to),
      "SELECTED_LABELS", "project", "organization",
      "AGGREGATION", agg, String(stepMs),
      "FILTER", `metric=${metric}`, ...filters,
    );
  } catch (err) {
    log.warn(`Couldn't read ${metric} series:`, err instanceof Error ? err.message : err);
    return [];
  }
  if (!Array.isArray(result)) return [];
  return (result as [string, [string, string | null][], [string | number, string][]][]).map(([, labels, points]) => {
    const l = Object.fromEntries((labels ?? []).map(([k, v]) => [k, v]));
    return { project: l.project ?? "", org: l.organization ?? null, points: (points ?? []).map(([t, v]) => [Number(t), Number(v)] as Point) };
  });
}

const seriesKey = (org: string | null, project: string) => `${org ?? ""}\u0000${project}`;

type AppMetrics = { cpu: (number | null)[]; memory: (number | null)[]; rx: (number | null)[]; tx: (number | null)[] };

/** Every app's last hour, summed across its containers, keyed by org and project label. */
async function readSparks(now: number): Promise<Map<string, AppMetrics>> {
  const from = Math.floor(now / SPARK_STEP) * SPARK_STEP - (SPARK_STEPS - 1) * SPARK_STEP;
  const n = SPARK_STEPS;
  const [cpu, memory, rx, tx] = await Promise.all([
    rangeByContainer("cpu", from, now, "avg", SPARK_STEP),
    rangeByContainer("memory", from, now, "avg", SPARK_STEP),
    // Counters: the last reading per step, a rate from consecutive steps. Starts a step early for the first rate.
    rangeByContainer("networkRx", from - SPARK_STEP, now, "last", SPARK_STEP),
    rangeByContainer("networkTx", from - SPARK_STEP, now, "last", SPARK_STEP),
  ]);
  const group = (list: Series[], shape: (s: Series) => (number | null)[]) => {
    const by = new Map<string, (number | null)[][]>();
    for (const s of list) {
      const k = seriesKey(s.org, s.project);
      by.set(k, [...(by.get(k) ?? []), shape(s)]);
    }
    return new Map([...by].map(([k, v]) => [k, sumSeries(v, n)]));
  };
  const gauge = (s: Series) => bucketSeries(s.points, from, SPARK_STEP, n);
  const rate = (s: Series) => counterRates(s.points, from, SPARK_STEP, n);
  const maps = { cpu: group(cpu, gauge), memory: group(memory, gauge), rx: group(rx, rate), tx: group(tx, rate) };
  const keys = new Set([...maps.cpu.keys(), ...maps.memory.keys(), ...maps.rx.keys(), ...maps.tx.keys()]);
  const empty = () => new Array<number | null>(n).fill(null);
  return new Map(
    [...keys].map((k) => [k, { cpu: maps.cpu.get(k) ?? empty(), memory: maps.memory.get(k) ?? empty(), rx: maps.rx.get(k) ?? empty(), tx: maps.tx.get(k) ?? empty() }]),
  );
}

async function readHostMemory(now: number): Promise<HostMemory | null> {
  const host = await detectHost();
  if (!host) return null;
  const from = Math.floor(now / HOST_STEP) * HOST_STEP - (HOST_STEPS - 1) * HOST_STEP;
  const pct = bucketSeries(await queryHostHistory("memory", from, now, HOST_STEP), from, HOST_STEP, HOST_STEPS);
  const history = pct.map((p) => (p === null ? null : (p / 100) * host.memoryBytes));
  const used = latest(history, 3);
  return used === null ? null : { totalBytes: host.memoryBytes, usedBytes: used, history };
}

// ---- Database -----------------------------------------------------------------

type AppDirectoryRow = {
  id: string;
  name: string;
  displayName: string;
  parentAppId: string | null;
  status: AppRow["status"];
  organizationId: string;
  orgName: string;
  orgSlug: string;
  projectName: string | null;
  containerMemoryLimit: number | null;
  memoryLimit: number | null;
  cpuLimit: number | null;
};

const readDirectory = (): Promise<AppDirectoryRow[]> =>
  db
    .select({
      id: apps.id,
      name: apps.name,
      displayName: apps.displayName,
      parentAppId: apps.parentAppId,
      status: apps.status,
      organizationId: apps.organizationId,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      projectName: projects.displayName,
      containerMemoryLimit: apps.containerMemoryLimit,
      memoryLimit: apps.memoryLimit,
      cpuLimit: apps.cpuLimit,
    })
    .from(apps)
    .innerJoin(organizations, eq(organizations.id, apps.organizationId))
    .leftJoin(projects, eq(projects.id, apps.projectId))
    .limit(2000);

type DeploySpanRow = { id: string; appId: string; status: string; startedAt: Date; claimedAt: Date | null; finishedAt: Date | null; timings: StageTimings | null };

const readDeploySpans = (since: number, appIds?: string[]): Promise<DeploySpanRow[]> =>
  db
    .select({
      id: deployments.id,
      appId: deployments.appId,
      status: deployments.status,
      startedAt: deployments.startedAt,
      claimedAt: deployments.claimedAt,
      finishedAt: deployments.finishedAt,
      timings: deployments.stageTimings,
    })
    .from(deployments)
    .where(
      and(
        appIds ? inArray(deployments.appId, appIds) : undefined,
        or(gt(deployments.startedAt, new Date(since)), gt(deployments.finishedAt, new Date(since)), inArray(deployments.status, ["queued", "running"])),
        sql`${deployments.status} <> 'superseded'`,
      ),
    )
    .orderBy(deployments.startedAt)
    .limit(5000);

const toRibbonDeploy = (r: DeploySpanRow, now: number): RibbonDeploy & { id: string; status: string } => {
  const queuedAt = r.startedAt.getTime();
  const finishedAt = time(r.finishedAt);
  return {
    id: r.id,
    status: r.status,
    ...ribbonDeploy({ queuedAt, finishedAt, status: r.status, segments: deploySegments({ status: r.status, queuedAt, claimedAt: time(r.claimedAt), finishedAt, timings: r.timings }, now) }),
  };
};

/** The newest finished deploy per app. */
const readLastDeploys = () =>
  db
    .selectDistinctOn([deployments.appId], {
      appId: deployments.appId,
      status: deployments.status,
      startedAt: deployments.startedAt,
      finishedAt: deployments.finishedAt,
    })
    .from(deployments)
    .where(and(isNotNull(deployments.finishedAt), inArray(deployments.status, ["success", "failed", "rolled_back"])))
    .orderBy(deployments.appId, desc(deployments.startedAt));

type BackupSpanRow = { appId: string | null; status: string; startedAt: Date; finishedAt: Date | null };

const readBackupSpans = (since: number, appIds?: string[]): Promise<BackupSpanRow[]> =>
  db
    .select({ appId: backups.appId, status: backups.status, startedAt: backups.startedAt, finishedAt: backups.finishedAt })
    .from(backups)
    .where(and(appIds ? inArray(backups.appId, appIds) : undefined, or(gt(backups.startedAt, new Date(since)), eq(backups.status, "running"))))
    .orderBy(backups.startedAt)
    .limit(5000);

const toBackupSpan = (b: BackupSpanRow): RibbonSpan => ({ start: b.startedAt.getTime(), end: b.status === "running" || b.status === "pending" ? null : (time(b.finishedAt) ?? b.startedAt.getTime()), failed: b.status === "failed" });

/** Cron runs counted per ribbon bucket, per app. */
const readCronBuckets = (since: number) =>
  db
    .select({
      appId: cronJobs.appId,
      bucket: sql<number>`floor(extract(epoch from ${cronJobRuns.startedAt}) * 1000 / ${CRON_BUCKET})::bigint`,
      runs: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${cronJobRuns.status} = 'failed')::int`,
    })
    .from(cronJobRuns)
    .innerJoin(cronJobs, eq(cronJobs.id, cronJobRuns.cronJobId))
    .where(and(isNotNull(cronJobs.appId), gt(cronJobRuns.startedAt, new Date(since))))
    .groupBy(cronJobs.appId, sql`2`);

type OutageRow = { appId: string | null; openedAt: Date; resolvedAt: Date | null };

const readOutages = (since: number, appIds?: string[]): Promise<OutageRow[]> =>
  db
    .select({ appId: incidents.appId, openedAt: incidents.openedAt, resolvedAt: incidents.resolvedAt })
    .from(incidents)
    .where(
      and(
        eq(incidents.kind, UPTIME_INCIDENT),
        appIds ? inArray(incidents.appId, appIds) : isNotNull(incidents.appId),
        or(isNull(incidents.resolvedAt), gt(incidents.resolvedAt, new Date(since))),
      ),
    )
    .limit(2000);

const toOutage = (o: OutageRow): RibbonSpan => ({ start: o.openedAt.getTime(), end: time(o.resolvedAt), failed: true });

/** Up and down minutes per app over the last 24 hours, from its monitors' hourly rollups. */
const readUptime = (since: number) =>
  db
    .select({
      appId: uptimeMonitors.appId,
      up: sql<number>`sum(${uptimeHourly.minutesUp})::int`,
      down: sql<number>`sum(${uptimeHourly.minutesDown})::int`,
    })
    .from(uptimeHourly)
    .innerJoin(uptimeMonitors, eq(uptimeMonitors.id, uptimeHourly.monitorId))
    .where(and(isNotNull(uptimeMonitors.appId), eq(uptimeMonitors.enabled, true), eq(uptimeMonitors.preview, false), gte(uptimeHourly.start, new Date(Math.floor(since / HOUR) * HOUR))))
    .groupBy(uptimeMonitors.appId);

async function deployContext(now: number): Promise<DeployContext> {
  const [targets, name] = await Promise.all([readTargets(), soft(getInstanceDisplayName(), null, "the instance name")]);
  return {
    now,
    builderName: new Map<string, string>([["local", name ?? "This server"], ...targets.map((t): [string, string] => [t.id, t.name])]),
    holding: new Map(),
    stageAt: new Map(),
    fellBack: new Set(),
  };
}

type DbPart = {
  at: number;
  instanceName: string;
  directory: AppDirectoryRow[];
  live: ReturnType<typeof toPipelineDeploy>[];
  spans: (RibbonDeploy & { id: string; appId: string; status: string })[];
  lastDeploys: Awaited<ReturnType<typeof readLastDeploys>>;
  backups: BackupSpanRow[];
  crons: Awaited<ReturnType<typeof readCronBuckets>>;
  outages: OutageRow[];
  uptime: Awaited<ReturnType<typeof readUptime>>;
};

let dbCache: { at: number; value: Promise<DbPart> } | null = null;

async function loadDbPart(now: number): Promise<DbPart> {
  const since = now - DAY;
  const [instanceName, directory, ctx, liveRows, spans, lastDeploys, backupRows, crons, outages, uptime] = await Promise.all([
    soft(getInstanceDisplayName(), null, "the instance name"),
    readDirectory(),
    deployContext(now),
    deployFrom().where(inArray(deployments.status, ["queued", "running"])).orderBy(deployments.startedAt).limit(200),
    soft(readDeploySpans(since), [], "deploys"),
    soft(readLastDeploys(), [], "last deploys"),
    soft(readBackupSpans(since), [], "backups"),
    soft(readCronBuckets(since), [], "cron runs"),
    soft(readOutages(since), [], "outages"),
    soft(readUptime(since), [], "uptime"),
  ]);
  return {
    at: now,
    instanceName: instanceName ?? "This server",
    directory,
    live: liveRows.map((r) => toPipelineDeploy(toRow(r), ctx)),
    spans: spans.map((r) => ({ ...toRibbonDeploy(r, now), appId: r.appId })),
    lastDeploys,
    backups: backupRows,
    crons,
    outages,
    uptime,
  };
}

function readDbPart(now: number): Promise<DbPart> {
  if (dbCache && now - dbCache.at < CACHE_MS) return dbCache.value;
  const value = loadDbPart(now);
  dbCache = { at: now, value };
  value.catch(() => {
    if (dbCache?.value === value) dbCache = null;
  });
  return value;
}

/** Child app ids to their stack's top app. */
function ownerOf(directory: AppDirectoryRow[]): (appId: string | null) => string | null {
  const parent = new Map(directory.map((a) => [a.id, a.parentAppId]));
  return (id) => {
    if (!id) return null;
    let at = id;
    for (let i = 0; i < 4; i++) {
      const p = parent.get(at);
      if (!p) return parent.has(at) ? at : null;
      at = p;
    }
    return at;
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ---- Snapshot -----------------------------------------------------------------

export async function readAppsSnapshot(): Promise<AppsSnapshot> {
  const now = Date.now();
  const [part, sparks, host] = await Promise.all([readDbPart(now), soft(readSparks(now), new Map(), "metrics"), soft(readHostMemory(now), null, "host memory")]);
  const since = now - DAY;
  const owner = ownerOf(part.directory);
  const tops = part.directory.filter((a) => !a.parentAppId);
  const members = new Map<string, AppDirectoryRow[]>();
  for (const a of part.directory) if (a.parentAppId) push(members, owner(a.id)!, a);

  const live = new Map<string, AppRow["deploy"]>();
  for (const d of part.live) {
    const id = owner(d.appId);
    if (id && !live.has(id)) live.set(id, d);
  }
  const deploys = new Map<string, RibbonDeploy[]>();
  for (const d of part.spans) {
    const id = owner(d.appId);
    if (id) push(deploys, id, { start: d.start, end: d.end, failed: d.failed, waits: d.waits });
  }
  const last = new Map<string, { status: string; startedAt: number; finishedAt: number }>();
  for (const r of part.lastDeploys) {
    const id = owner(r.appId);
    if (!id || !r.finishedAt) continue;
    const prev = last.get(id);
    if (!prev || r.finishedAt.getTime() > prev.finishedAt) last.set(id, { status: r.status, startedAt: r.startedAt.getTime(), finishedAt: r.finishedAt.getTime() });
  }
  const backupSpans = new Map<string, RibbonSpan[]>();
  for (const b of part.backups) {
    const id = owner(b.appId);
    if (id) push(backupSpans, id, toBackupSpan(b));
  }
  const cronRuns = new Map<string, { at: number; failed: boolean }[]>();
  for (const c of part.crons) {
    const id = owner(c.appId);
    if (!id) continue;
    const at = Number(c.bucket) * CRON_BUCKET;
    for (let i = 0; i < Number(c.runs); i++) push(cronRuns, id, { at, failed: i < Number(c.failed) });
  }
  const outages = new Map<string, RibbonSpan[]>();
  for (const o of part.outages) {
    const id = owner(o.appId);
    if (id) push(outages, id, toOutage(o));
  }
  const uptime = new Map<string, { up: number; down: number }>();
  for (const u of part.uptime) {
    const id = owner(u.appId);
    if (!id) continue;
    const prev = uptime.get(id) ?? { up: 0, down: 0 };
    uptime.set(id, { up: prev.up + Number(u.up ?? 0), down: prev.down + Number(u.down ?? 0) });
  }

  const empty = new Array<number | null>(SPARK_STEPS).fill(null);
  const rows: AppRow[] = tops.map((a) => {
    const m = sparks.get(seriesKey(a.organizationId, a.name)) ?? sparks.get(seriesKey(null, a.name));
    const net = m ? sumSeries([m.rx, m.tx], SPARK_STEPS) : empty;
    const kids = members.get(a.id) ?? [];
    const out = mergeSpans(outages.get(a.id) ?? []);
    const u = uptime.get(a.id);
    return {
      id: a.id,
      slug: a.name,
      name: a.displayName,
      orgId: a.organizationId,
      orgName: a.orgName,
      orgSlug: a.orgSlug,
      projectName: a.projectName,
      status: a.status,
      deploy: live.get(a.id) ?? null,
      down: out.some((o) => o.end === null),
      cpu: m ? latest(m.cpu) : null,
      cpuLimit: kids.length ? null : a.cpuLimit,
      memory: m ? latest(m.memory) : null,
      memoryLimit: memoryLimitOf(kids.length ? kids : [a]),
      rx: m ? latest(m.rx) : null,
      tx: m ? latest(m.tx) : null,
      spark: { cpu: m?.cpu ?? empty, memory: m?.memory ?? empty, net },
      uptime: u ? uptimeRatio(u.up, u.down) : null,
      lastDeploy: lastDeployOf(last.get(a.id) ?? null),
      ribbon: {
        deploys: deploys.get(a.id) ?? [],
        backups: backupSpans.get(a.id) ?? [],
        crons: cronMarks(cronRuns.get(a.id) ?? [], CRON_BUCKET),
        outages: out,
      },
    };
  });

  const finished = part.spans.filter((d) => d.end !== null && d.end > since);
  const doneBackups = part.backups.filter((b) => b.finishedAt && b.finishedAt.getTime() > since && b.status !== "running");
  const up = [...uptime.values()].reduce((s, u) => s + u.up, 0);
  const down = [...uptime.values()].reduce((s, u) => s + u.down, 0);
  const totals: AppsTotals = {
    deploys: finished.length,
    deploysFailed: finished.filter((d) => d.failed).length,
    backups: doneBackups.length,
    backupsFailed: doneBackups.filter((b) => b.status === "failed").length,
    uptime: uptimeRatio(up, down),
    outages: rows.reduce((n, r) => n + r.ribbon.outages.filter((o) => (o.end ?? now) > since).length, 0),
  };

  return { at: now, instanceName: part.instanceName, sparkStepMs: SPARK_STEP, host, totals, apps: rows };
}

// ---- Drill-in -----------------------------------------------------------------

/** Chart steps across the drill-in's window. */
const DRILL_STEPS = 120;
const EVENTS_MS = 12 * HOUR;

/** One app's window around its latest notable event. Null when the app doesn't exist. */
export async function readAppDrill(appId: string): Promise<AppDrill | null> {
  const now = Date.now();
  const [app] = await db
    .select({ id: apps.id, name: apps.name, organizationId: apps.organizationId, containerMemoryLimit: apps.containerMemoryLimit, memoryLimit: apps.memoryLimit })
    .from(apps)
    .where(eq(apps.id, appId));
  if (!app) return null;
  const kids = await db
    .select({ id: apps.id, containerMemoryLimit: apps.containerMemoryLimit, memoryLimit: apps.memoryLimit })
    .from(apps)
    .where(eq(apps.parentAppId, appId));
  const ids = [appId, ...kids.map((k) => k.id)];
  const since = now - DAY;

  const [spans, outageRows] = await Promise.all([readDeploySpans(since, ids), soft(readOutages(since, ids), [], "outages")]);
  const outages = mergeSpans(outageRows.map(toOutage));
  const focus = pickFocus(
    spans.map((d) => ({ id: d.id, status: d.status, queuedAt: d.startedAt.getTime(), finishedAt: time(d.finishedAt) })),
    outages,
    now,
  );
  const { from, to } = focusWindow(focus, now);
  const stepMs = Math.max(5_000, Math.ceil((to - from) / DRILL_STEPS / 1000) * 1000);
  const n = Math.ceil((to - from) / stepMs);
  const filters = [`project=${app.name}`, `organization=${app.organizationId}`];

  const [ctx, windowRows, eventRows, backupRows, cronRows, cpu, memory] = await Promise.all([
    deployContext(now),
    deployFrom()
      .where(and(inArray(deployments.appId, ids), lt(deployments.startedAt, new Date(to)), or(isNull(deployments.finishedAt), gt(deployments.finishedAt, new Date(from)))))
      .orderBy(deployments.startedAt)
      .limit(50),
    db
      .select({ id: deployments.id, status: deployments.status, startedAt: deployments.startedAt, finishedAt: deployments.finishedAt })
      .from(deployments)
      .where(and(inArray(deployments.appId, ids), gt(deployments.startedAt, new Date(now - EVENTS_MS)), sql`${deployments.status} <> 'superseded'`))
      .orderBy(desc(deployments.startedAt))
      .limit(30),
    soft(readBackupSpans(Math.min(from, now - EVENTS_MS), ids), [], "backups"),
    soft(
      db
        .select({ at: cronJobRuns.startedAt, name: cronJobs.name, status: cronJobRuns.status })
        .from(cronJobRuns)
        .innerJoin(cronJobs, eq(cronJobs.id, cronJobRuns.cronJobId))
        .where(and(inArray(cronJobs.appId, ids), eq(cronJobRuns.status, "failed"), gt(cronJobRuns.startedAt, new Date(now - EVENTS_MS))))
        .orderBy(desc(cronJobRuns.startedAt))
        .limit(10),
      [],
      "cron runs",
    ),
    rangeByContainer("cpu", from, to, "avg", stepMs, filters),
    rangeByContainer("memory", from, to, "avg", stepMs, filters),
  ]);
  const latestId = (
    await db.select({ id: deployments.id }).from(deployments).where(inArray(deployments.appId, ids)).orderBy(desc(deployments.startedAt)).limit(1)
  )[0]?.id ?? null;

  const sum = (list: Series[]) => sumSeries(list.map((s) => bucketSeries(s.points, from, stepMs, n)), n);
  const windowDeploys = windowRows.map((r) => {
    const row = toRow(r);
    return { ...toPipelineDeploy(row, ctx), commit: null as string | null };
  });
  const commits = windowDeploys.length
    ? await db.select({ id: deployments.id, gitMessage: deployments.gitMessage }).from(deployments).where(inArray(deployments.id, windowDeploys.map((d) => d.id)))
    : [];
  const commitOf = new Map(commits.map((c) => [c.id, c.gitMessage?.split("\n")[0] ?? null]));
  for (const d of windowDeploys) d.commit = commitOf.get(d.id) ?? null;

  const failures = new Map(windowDeploys.map((d) => [d.id, d.failure]));
  const backupSpans = backupRows.map(toBackupSpan);
  return {
    appId,
    focus,
    from,
    to,
    stepMs,
    deploys: windowDeploys,
    backups: backupSpans.filter((b) => (b.end ?? now) > from && b.start < to),
    outages: outages.filter((o) => (o.end ?? now) > from && o.start < to),
    memory: sum(memory),
    cpu: sum(cpu),
    memoryLimit: memoryLimitOf(kids.length ? kids : [app]),
    events: drillEvents(
      {
        deploys: eventRows.map((r) => ({ id: r.id, status: r.status, queuedAt: r.startedAt.getTime(), finishedAt: time(r.finishedAt), failure: failures.get(r.id) ?? null })),
        outages: outages.filter((o) => (o.end ?? now) > now - EVENTS_MS),
        backups: backupSpans.filter((b) => b.start > now - EVENTS_MS),
        crons: cronRows.map((c) => ({ at: c.at.getTime(), name: c.name, failed: c.status === "failed" })),
      },
      now,
    ),
    latestDeployId: latestId,
  };
}
