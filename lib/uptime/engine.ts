// What the worker runs: due checks from the local vantage point, rollups, alerts, retention and auto monitors.

import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains, environments, uptimeDaily, uptimeHourly, uptimeMonitors, uptimeResults } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { consoleBaseUrl } from "@/lib/incidents/key";
import { openUptimeIncident, resolveUptimeIncident } from "@/lib/incidents/uptime";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { nanoid } from "nanoid";
import {
  DAY_MS,
  DEFAULT_EXPECTED_STATUS,
  DEFAULT_HTTP_TIMEOUT_MS,
  HOUR_MS,
  combine,
  evaluate,
  hourlySummary,
  runCheck,
  signRecord,
  summarize,
  type Bucket,
  type CheckResult,
  type HttpCheck,
  type Monitor,
} from "./core";
import { LOCAL_VANTAGE_ID, ensureLocalVantage, listVantagePoints, localSigningKey } from "./vantage";

const log = logger.child("uptime");

const RAW_RETENTION_MS = 14 * DAY_MS;
const HOURLY_RETENTION_MS = 365 * DAY_MS;
const RECENT_MS = 15 * 60_000;
const CONCURRENCY = 20;
const CONSOLE_MONITOR_ID = "mon_console";

const lastRun = new Map<string, number>();
const alerted = new Set<string>();
const seenUp = new Set<string>();
let seeded = false;
let lastRollup = 0;
let lastPrune = 0;

const httpCheck = (url: string): HttpCheck => ({
  type: "http",
  url,
  expectedStatus: { ...DEFAULT_EXPECTED_STATUS },
  timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
});

function domainUrl(d: { domain: string; pathPrefix: string | null; sslEnabled: boolean | null }): string {
  return `${d.sslEnabled === false ? "http" : "https"}://${d.domain}${d.pathPrefix ?? ""}`;
}

/** Creates, updates and removes auto monitors to match the apps' domains, previews and the console. */
export async function syncAutoMonitors(): Promise<{ added: number; removed: number }> {
  let added = 0;
  let removed = 0;

  const domainRows = await db
    .select({
      id: domains.id,
      domain: domains.domain,
      pathPrefix: domains.pathPrefix,
      sslEnabled: domains.sslEnabled,
      appId: domains.appId,
      orgId: apps.organizationId,
    })
    .from(domains)
    .innerJoin(apps, eq(apps.id, domains.appId))
    .where(and(eq(domains.enabled, true), eq(apps.isSystemManaged, false)));

  const previewRows = await db
    .select({ id: environments.id, domain: environments.domain, appId: environments.appId, orgId: apps.organizationId })
    .from(environments)
    .innerJoin(apps, eq(apps.id, environments.appId))
    .where(and(eq(environments.type, "preview"), isNotNull(environments.domain), eq(apps.isSystemManaged, false)));

  const existing = await db.select().from(uptimeMonitors).where(eq(uptimeMonitors.source, "auto"));
  const byDomain = new Map(existing.filter((m) => m.domainId).map((m) => [m.domainId!, m]));
  const byEnv = new Map(existing.filter((m) => m.environmentId).map((m) => [m.environmentId!, m]));

  const wanted: { key: string; row: typeof uptimeMonitors.$inferInsert }[] = [];
  for (const d of domainRows) {
    const url = domainUrl(d);
    wanted.push({
      key: `d:${d.id}`,
      row: { id: `mon_${nanoid(16)}`, organizationId: d.orgId, name: d.domain + (d.pathPrefix ?? ""), check: httpCheck(url), source: "auto", appId: d.appId, domainId: d.id },
    });
  }
  for (const p of previewRows) {
    wanted.push({
      key: `e:${p.id}`,
      row: { id: `mon_${nanoid(16)}`, organizationId: p.orgId, name: p.domain!, check: httpCheck(`https://${p.domain}`), source: "auto", appId: p.appId, environmentId: p.id, preview: true },
    });
  }

  const keep = new Set<string>();
  for (const w of wanted) {
    const current = w.key.startsWith("d:") ? byDomain.get(w.row.domainId!) : byEnv.get(w.row.environmentId!);
    if (!current) {
      await db.insert(uptimeMonitors).values(w.row).onConflictDoNothing();
      added++;
      continue;
    }
    keep.add(current.id);
    const check = w.row.check as HttpCheck;
    if (current.check.type !== "http" || current.check.url !== check.url || current.name !== w.row.name || current.organizationId !== w.row.organizationId) {
      await db
        .update(uptimeMonitors)
        .set({ check: current.check.type === "http" ? { ...current.check, url: check.url } : check, name: w.row.name as string, organizationId: w.row.organizationId, updatedAt: new Date() })
        .where(eq(uptimeMonitors.id, current.id));
    }
  }

  // Console: one instance monitor.
  const consoleUrl = `${consoleBaseUrl()}/api/health`;
  const consoleRow = existing.find((m) => m.id === CONSOLE_MONITOR_ID);
  keep.add(CONSOLE_MONITOR_ID);
  if (!consoleRow) {
    await db
      .insert(uptimeMonitors)
      .values({ id: CONSOLE_MONITOR_ID, organizationId: null, name: "Vardo console", check: httpCheck(consoleUrl), source: "auto" })
      .onConflictDoNothing();
    added++;
  } else if (consoleRow.check.type === "http" && consoleRow.check.url !== consoleUrl) {
    await db.update(uptimeMonitors).set({ check: { ...consoleRow.check, url: consoleUrl }, updatedAt: new Date() }).where(eq(uptimeMonitors.id, CONSOLE_MONITOR_ID));
  }

  for (const m of existing) {
    if (keep.has(m.id)) continue;
    await db.delete(uptimeMonitors).where(eq(uptimeMonitors.id, m.id));
    lastRun.delete(m.id);
    removed++;
  }
  return { added, removed };
}

async function seedLastRun(): Promise<void> {
  if (seeded) return;
  seeded = true;
  const rows = await db
    .select({ monitorId: uptimeResults.monitorId, at: sql<Date>`max(${uptimeResults.at})` })
    .from(uptimeResults)
    .where(and(eq(uptimeResults.vantageId, LOCAL_VANTAGE_ID), gte(uptimeResults.at, new Date(Date.now() - 10 * 60_000))))
    .groupBy(uptimeResults.monitorId);
  for (const r of rows) lastRun.set(r.monitorId, new Date(r.at).getTime());
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export function inMaintenance(m: Pick<Monitor, "maintenance">, now: number): boolean {
  return (m.maintenance ?? []).some((w) => now >= w.start && now < w.end);
}

/** Runs the checks that are due, stores them, and opens or resolves incidents. */
export async function runDueChecks(now = Date.now(), clock?: () => number): Promise<number> {
  await seedLastRun();
  const local = await ensureLocalVantage();
  const rows = await db
    .select({ monitor: uptimeMonitors, appStatus: apps.status })
    .from(uptimeMonitors)
    .leftJoin(apps, eq(apps.id, uptimeMonitors.appId))
    .where(eq(uptimeMonitors.enabled, true));

  // A stopped app is expected to be down.
  const due = rows.filter(({ monitor, appStatus }) => {
    if (monitor.source === "auto" && appStatus === "stopped") return false;
    return now - (lastRun.get(monitor.id) ?? 0) >= monitor.intervalSec * 1000 - 1000;
  });
  if (due.length === 0) return 0;

  const fresh: CheckResult[] = [];
  await pool(due, CONCURRENCY, async ({ monitor }) => {
    lastRun.set(monitor.id, now);
    try {
      fresh.push(await runCheck({ id: monitor.id, check: monitor.check }, local.id, { now: clock }));
    } catch (err) {
      log.warn(`Check for ${monitor.id} threw:`, err);
    }
  });

  if (fresh.length > 0) {
    await db.insert(uptimeResults).values(
      fresh.map((r) => ({
        monitorId: r.monitorId,
        vantageId: r.vantageId,
        at: new Date(r.at),
        ok: r.ok,
        latencyMs: r.latencyMs,
        status: r.status ?? null,
        error: r.error ?? null,
        certDaysLeft: r.certDaysLeft ?? null,
      })),
    );
    await syncAlerts(due.map((d) => d.monitor).filter((m) => fresh.some((r) => r.monitorId === m.id)), now);
  }
  return fresh.length;
}

async function syncAlerts(monitors: (typeof uptimeMonitors.$inferSelect)[], now: number): Promise<void> {
  if (monitors.length === 0) return;
  const vantages = await listVantagePoints();
  const recent = await db
    .select()
    .from(uptimeResults)
    .where(and(inArray(uptimeResults.monitorId, monitors.map((m) => m.id)), gte(uptimeResults.at, new Date(now - RECENT_MS))));
  const results: CheckResult[] = recent.map((r) => ({
    monitorId: r.monitorId,
    vantageId: r.vantageId,
    at: r.at.getTime(),
    ok: r.ok,
    latencyMs: r.latencyMs,
  }));
  const operator = monitors.some((m) => !m.organizationId) ? await adminOrgIds() : [];

  for (const m of monitors) {
    try {
      const evaluation = evaluate({ vantages, results: results.filter((r) => r.monitorId === m.id), now, intervalSec: m.intervalSec });
      const outage = {
        about: m.id,
        title: `${m.name} is down`,
        orgIds: m.organizationId ? [m.organizationId] : operator,
        appId: m.appId ?? undefined,
      };
      if (evaluation.state === "down") {
        const silent = m.muted || inMaintenance({ maintenance: m.maintenance }, now);
        if (silent || alerted.has(m.id)) continue;
        await openUptimeIncident(outage, `${m.name} isn't responding${evaluation.localOnly ? " from this instance" : ""}.`);
        alerted.add(m.id);
      } else if (evaluation.state === "up" && (alerted.delete(m.id) || !seenUp.has(m.id))) {
        await resolveUptimeIncident(outage, `${m.name} is responding again.`);
      }
      if (evaluation.state === "up") seenUp.add(m.id);
    } catch (err) {
      log.error(`Alert sync for ${m.id} failed:`, err);
    }
  }
}

type BucketRow = { monitorId: string; start: Date; minutesUp: number; minutesDown: number; minutesUnknown: number; medianLatencyMs: number | null };

const toRow = (monitorId: string, b: Bucket): BucketRow => ({
  monitorId,
  start: new Date(b.start),
  minutesUp: b.minutesUp,
  minutesDown: b.minutesDown,
  minutesUnknown: b.minutesUnknown,
  medianLatencyMs: b.medianLatencyMs,
});

/** Recomputes the current and previous hour for each monitor, signs them, and folds the hours into their days. */
export async function rollup(now = Date.now()): Promise<void> {
  const monitors = await db.select({ id: uptimeMonitors.id, intervalSec: uptimeMonitors.intervalSec }).from(uptimeMonitors);
  if (monitors.length === 0) return;
  const thisHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const from = thisHour - HOUR_MS;
  const [vantages, key, raw] = await Promise.all([
    listVantagePoints(),
    localSigningKey(),
    db
      .select()
      .from(uptimeResults)
      .where(and(inArray(uptimeResults.monitorId, monitors.map((m) => m.id)), gte(uptimeResults.at, new Date(from - 10 * 60_000)))),
  ]);
  const byMonitor = new Map<string, CheckResult[]>();
  for (const r of raw) {
    const list = byMonitor.get(r.monitorId) ?? [];
    list.push({ monitorId: r.monitorId, vantageId: r.vantageId, at: r.at.getTime(), ok: r.ok, latencyMs: r.latencyMs });
    byMonitor.set(r.monitorId, list);
  }

  const signedAt = new Date(now);
  for (const m of monitors) {
    const buckets = summarize({ results: byMonitor.get(m.id) ?? [], vantages, intervalSec: m.intervalSec, from, to: now + 1, bucketMs: HOUR_MS });
    for (const b of buckets) {
      if (b.minutesUp + b.minutesDown === 0 && b.minutesUnknown === 0) continue;
      const signed = signRecord(hourlySummary(LOCAL_VANTAGE_ID, m.id, b, now), key);
      const row = { ...toRow(m.id, b), record: signed.payload, sig: signed.sig, signedAt };
      await db
        .insert(uptimeHourly)
        .values(row)
        .onConflictDoUpdate({
          target: [uptimeHourly.monitorId, uptimeHourly.start],
          set: { minutesUp: row.minutesUp, minutesDown: row.minutesDown, minutesUnknown: row.minutesUnknown, medianLatencyMs: row.medianLatencyMs, record: row.record, sig: row.sig, signedAt },
        });
    }
    await rollDays(m.id, [...new Set(buckets.map((b) => Math.floor(b.start / DAY_MS) * DAY_MS))]);
  }
}

async function rollDays(monitorId: string, days: number[]): Promise<void> {
  for (const day of days) {
    const hours = await db
      .select()
      .from(uptimeHourly)
      .where(and(eq(uptimeHourly.monitorId, monitorId), gte(uptimeHourly.start, new Date(day)), lt(uptimeHourly.start, new Date(day + DAY_MS))));
    if (hours.length === 0) continue;
    const b = combine(
      hours.map((h) => ({ start: h.start.getTime(), minutesUp: h.minutesUp, minutesDown: h.minutesDown, minutesUnknown: h.minutesUnknown, uptimePct: null, medianLatencyMs: h.medianLatencyMs })),
      day,
    );
    const row = toRow(monitorId, b);
    await db
      .insert(uptimeDaily)
      .values(row)
      .onConflictDoUpdate({
        target: [uptimeDaily.monitorId, uptimeDaily.start],
        set: { minutesUp: row.minutesUp, minutesDown: row.minutesDown, minutesUnknown: row.minutesUnknown, medianLatencyMs: row.medianLatencyMs },
      });
  }
}

/** Raw results past 14 days and hourly rollups past a year. Daily rollups stay. */
export async function prune(now = Date.now()): Promise<void> {
  await db.delete(uptimeResults).where(lt(uptimeResults.at, new Date(now - RAW_RETENTION_MS)));
  await db.delete(uptimeHourly).where(lt(uptimeHourly.start, new Date(now - HOURLY_RETENTION_MS)));
}

/** One pass of the worker loop. */
export async function tickUptime(now = Date.now()): Promise<void> {
  await syncIfDue(now);
  await runDueChecks(now);
  if (now - lastRollup >= 60_000) {
    lastRollup = now;
    await rollup(now);
  }
  if (now - lastPrune >= HOUR_MS) {
    lastPrune = now;
    await prune(now);
  }
}

let lastSync = 0;
async function syncIfDue(now: number): Promise<void> {
  if (now - lastSync < 60_000) return;
  lastSync = now;
  const { added, removed } = await syncAutoMonitors();
  if (added || removed) log.info(`Auto monitors: ${added} added, ${removed} removed`);
}
