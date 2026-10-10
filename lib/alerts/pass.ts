// One alert pass: reads the host, the apps' conditions, recent OOM kills and anomalies, then notifies each org once.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ANOMALY_ALERT_TYPES, anomalyObservations } from "@/lib/anomaly/pass";
import { db } from "@/lib/db";
import { stackedName } from "@/lib/email/format";
import { apps } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { getLatestSnapshot } from "@/lib/metrics/broadcast";
import { storeHostSample } from "@/lib/metrics/store-host";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { notifyObservations, type Observation } from "@/lib/notifications/observations";
import type { AlertType } from "@/lib/notifications/registry";
import { APP_ALERT_TYPES, conditionObservations, type ConditionApp } from "./apps";
import { autotuneHaltObservation } from "./autotune";
import { HostSampleBuffer, hostObservations, readHostSample, type HostSample } from "./host";
import { oomObservation, OOM_SETTLE_MS, recentOomKills, type OomRecord } from "./oom";

const log = logger.child("alerts");

/** A host OOM kill this recent confirms memory pressure without waiting out the window. */
const OOM_CONFIRMS_MS = 5 * 60_000;

const TOP_CONTAINERS = 3;

const buffer = new HostSampleBuffer();

/** How often auto-adjust sweeps for pressure, settling and lowering. */
const AUTOTUNE_SWEEP_MS = 60 * 60_000;
let lastSweepAt = 0;

/** The OOM alert, with the follow-up once the kill has settled and before it's sent. */
async function oomAlert(record: OomRecord, now: number): Promise<Observation> {
  const settled = record.path === "process" || now - record.lastAt >= OOM_SETTLE_MS;
  if (record.sent || !settled) return oomObservation(record, null, now);
  try {
    const { oomFollowup } = await import("./oom-followup");
    return oomObservation(record, await oomFollowup(record, now), now);
  } catch (err) {
    log.error(`OOM follow-up failed for ${record.appId}:`, err);
    return oomObservation(record, null, now);
  }
}

async function autotuneAlerts(): Promise<{ organizationId: string; observation: Observation }[]> {
  try {
    const { haltedApps } = await import("@/lib/autotune/run");
    return (await haltedApps()).map((h) => ({ organizationId: h.organizationId, observation: autotuneHaltObservation(h) }));
  } catch (err) {
    log.error("Reading auto-adjust state failed:", err);
    return [];
  }
}

async function maybeSweepAutotune(kills: OomRecord[], now: number): Promise<void> {
  if (now - lastSweepAt < AUTOTUNE_SWEEP_MS) return;
  lastSweepAt = now;
  const lastKill = new Map(kills.map((k) => [k.appId, k.lastAt]));
  try {
    const { runAutotuneSweep } = await import("@/lib/autotune/run");
    await runAutotuneSweep(new Date(now), (appId) => lastKill.get(appId) ?? null);
  } catch (err) {
    log.error("Auto-adjust sweep failed:", err);
  }
}

async function conditionApps(): Promise<ConditionApp[]> {
  const stacks = alias(apps, "stacks");
  const rows = await db
    .select({
      id: apps.id,
      name: apps.displayName,
      stack: stacks.displayName,
      organizationId: apps.organizationId,
      conditions: apps.conditions,
    })
    .from(apps)
    .leftJoin(stacks, eq(stacks.id, apps.parentAppId))
    .where(and(isNotNull(apps.conditions), sql`jsonb_array_length(${apps.conditions}) > 0`));
  return rows.flatMap(({ stack, ...r }) =>
    r.conditions?.length ? [{ ...r, name: stackedName(r.name, stack), conditions: r.conditions }] : [],
  );
}

function topMemory(): { name: string; bytes: number }[] {
  return [...(getLatestSnapshot() ?? [])]
    .sort((a, b) => b.memoryUsage - a.memoryUsage)
    .slice(0, TOP_CONTAINERS)
    .map((m) => ({ name: m.containerName, bytes: m.memoryUsage }));
}

export async function runAlertPass(input: { disk: HostSample["disk"] }, now = Date.now()): Promise<void> {
  const sample = await readHostSample(input.disk, now);
  buffer.push(sample);
  storeHostSample(now, {
    memory: sample.memory?.percent,
    swap: sample.swap?.percent,
    cpu: sample.cpuPercent,
    load: sample.load?.ratio,
    disk: sample.disk?.percent,
  }).catch(() => {});

  const kills = recentOomKills(now);
  const host = hostObservations(buffer, now, { topMemory: topMemory() }, {
    memoryConfirmed: kills.some((k) => k.hostKill && now - k.lastAt <= OOM_CONFIRMS_MS),
  });

  const byOrg = new Map<string, Observation[]>();
  const add = (orgId: string, o: Observation) => byOrg.set(orgId, [...(byOrg.get(orgId) ?? []), o]);
  for (const app of await conditionApps()) {
    for (const o of conditionObservations(app, now)) add(app.organizationId, o);
  }
  for (const record of kills) add(record.organizationId, await oomAlert(record, now));
  for (const { organizationId, observation } of await autotuneAlerts()) add(organizationId, observation);
  await maybeSweepAutotune(kills, now);

  let anomalies: Map<string, Observation[]> | null = null;
  try {
    anomalies = await anomalyObservations(now);
  } catch (err) {
    log.error("Anomaly pass failed:", err);
  }
  for (const [orgId, list] of anomalies ?? []) for (const o of list) add(orgId, o);

  const hostOrgs = new Set(await adminOrgIds());
  const orgs = await db.query.organizations.findMany({ columns: { id: true } });
  const at = new Date(now);
  for (const { id } of orgs) {
    const isHostOrg = hostOrgs.has(id);
    const evaluated: AlertType[] = [...(isHostOrg ? host.evaluated : []), ...APP_ALERT_TYPES, ...(anomalies ? ANOMALY_ALERT_TYPES : [])];
    const observations = [...(isHostOrg ? host.observations : []), ...(byOrg.get(id) ?? [])];
    try {
      const { fired } = await notifyObservations(id, evaluated, observations, at);
      for (const item of fired) {
        const record = item.type === "app.oom" ? kills.find((k) => k.organizationId === id && k.appId === item.about) : undefined;
        if (record) record.sent = true;
      }
    } catch (err) {
      log.error(`Alert pass failed for org ${id}:`, err);
    }
  }
}
