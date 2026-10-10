// One alert pass: reads the host, the apps' conditions and recent OOM kills, then notifies each org once.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { stackedName } from "@/lib/email/format";
import { apps } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { getLatestSnapshot } from "@/lib/metrics/broadcast";
import { storeHostSample } from "@/lib/metrics/store-host";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { notifyObservations, type Observation } from "@/lib/notifications/observations";
import type { AlertType } from "@/lib/notifications/registry";
import { APP_ALERT_TYPES, conditionObservations, oomObservation, type ConditionApp } from "./apps";
import { HostSampleBuffer, hostObservations, readHostSample, type HostSample } from "./host";
import { recentOomKills } from "./oom";

const log = logger.child("alerts");

/** A host OOM kill this recent confirms memory pressure without waiting out the window. */
const OOM_CONFIRMS_MS = 5 * 60_000;

const TOP_CONTAINERS = 3;

const buffer = new HostSampleBuffer();

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
  for (const record of kills) add(record.organizationId, oomObservation(record));

  const hostOrgs = new Set(await adminOrgIds());
  const orgs = await db.query.organizations.findMany({ columns: { id: true } });
  const at = new Date(now);
  for (const { id } of orgs) {
    const isHostOrg = hostOrgs.has(id);
    const evaluated: AlertType[] = [...(isHostOrg ? host.evaluated : []), ...APP_ALERT_TYPES];
    const observations = [...(isHostOrg ? host.observations : []), ...(byOrg.get(id) ?? [])];
    try {
      await notifyObservations(id, evaluated, observations, at);
    } catch (err) {
      log.error(`Alert pass failed for org ${id}:`, err);
    }
  }
}
