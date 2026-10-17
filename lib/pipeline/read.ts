// Reads what the Pipeline snapshot needs: deploy rows, the build gate in Redis, targets, jobs, loops and recent events.

import { and, desc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, backups, cronJobRuns, cronJobs, deployments } from "@/lib/db/schema";
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
  type BackupRow,
  type CronRow,
  type DeployRow,
  type DrillRow,
  type GateState,
  type TargetConfig,
} from "./snapshot";
import type { PipelineSnapshot, PipelineTotals } from "./types";

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

const readTargets = () =>
  cached(
    targetsCache,
    async () => (await configuredTargets()).map((t): TargetConfig => ({ id: t.id, name: t.name, kind: t.kind, maxConcurrent: t.maxConcurrent })),
    [],
    (v) => (targetsCache = v),
  );

const readLocalSlots = () => cached(limitCache, localBuildLimit, 1, (v) => (limitCache = v));

const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

async function readDeploys(now: number): Promise<DeployRow[]> {
  const rows = await db
    .select({
      id: deployments.id,
      appId: deployments.appId,
      appName: apps.displayName,
      status: deployments.status,
      stage: deployments.stage,
      waitReason: deployments.waitReason,
      waitingSince: deployments.waitingSince,
      startedAt: deployments.startedAt,
      claimedAt: deployments.claimedAt,
      finishedAt: deployments.finishedAt,
      buildOutcome: deployments.buildOutcome,
      buildTargetId: deployments.buildTargetId,
      buildTargetName: deployments.buildTargetName,
    })
    .from(deployments)
    .innerJoin(apps, eq(apps.id, deployments.appId))
    .where(
      or(
        inArray(deployments.status, ["queued", "running"]),
        and(isNotNull(deployments.finishedAt), gt(deployments.finishedAt, new Date(now - LINGER_MS))),
      ),
    )
    .orderBy(deployments.startedAt)
    .limit(100);
  return rows.map((r) => ({
    id: r.id,
    appId: r.appId,
    appName: r.appName,
    status: r.status,
    stage: r.stage,
    waitReason: r.waitReason,
    waitingSince: time(r.waitingSince),
    queuedAt: time(r.startedAt)!,
    claimedAt: time(r.claimedAt),
    finishedAt: time(r.finishedAt),
    buildOutcome: r.buildOutcome,
    buildTargetId: r.buildTargetId,
    buildTargetName: r.buildTargetName,
  }));
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

async function readTotals(now: number): Promise<PipelineTotals> {
  const [row] = await db
    .select({
      live: sql<number>`count(*) filter (where ${deployments.status} = 'success')`,
      elsewhere: sql<number>`count(*) filter (where ${deployments.buildOutcome} = 'target')`,
      fellBack: sql<number>`count(*) filter (where ${deployments.buildOutcome} = 'fallback')`,
      failed: sql<number>`count(*) filter (where ${deployments.status} in ('failed', 'rolled_back'))`,
    })
    .from(deployments)
    .where(gt(deployments.finishedAt, new Date(now - 24 * 60 * 60_000)));
  return { live: Number(row?.live ?? 0), elsewhere: Number(row?.elsewhere ?? 0), fellBack: Number(row?.fellBack ?? 0), failed: Number(row?.failed ?? 0) };
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
  const [instanceName, localSlots, gate, deploys, events, backupRows, drills, crons, loops, totals] = await Promise.all([
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
  ]);
  const eventApps = await soft(readEventApps(events, new Set(deploys.map((d) => d.id))), {}, "app names");
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
  });
}
