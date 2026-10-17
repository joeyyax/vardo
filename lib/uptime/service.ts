// Uptime service: monitors and their state, read from the tables. Callers check access first.

import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import {
  notificationChannels,
  uptimeDaily,
  uptimeHourly,
  uptimeMonitors,
  uptimeResults,
  type UptimeMonitorRow,
} from "@/lib/db/schema";
import { listUptimeIncidents } from "@/lib/incidents/uptime";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import {
  DAY_MS,
  DEFAULT_EXPECTED_STATUS,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_INTERVAL,
  DEFAULT_TLS_PORT,
  DEFAULT_TLS_WARN_DAYS,
  HOUR_MS,
  combine,
  evaluate,
  fillDays,
  findOutages,
  median,
  rangeUptime,
  type Bucket,
  type Check,
  type CheckResult,
  type Evaluation,
  type VantagePoint,
} from "./core";
import type {
  AppUptime,
  CreateMonitorInput,
  DayTick,
  LatencySeries,
  MonitorDetail,
  MonitorSummary,
  OutageView,
  Scope,
  UpdateMonitorInput,
  VantageStateView,
} from "./types";
import { listVantagePoints } from "./vantage";

const MINUTE_MS = 60_000;
const RESULT_RETENTION_DAYS = 14;

export class UptimeInputError extends Error {}

export function scopeWhere(scope: Scope) {
  return scope.kind === "org" ? eq(uptimeMonitors.organizationId, scope.orgId) : isNull(uptimeMonitors.organizationId);
}

export function targetOf(check: Check): string {
  return check.type === "http" ? check.url : `${check.host}:${check.port}`;
}

function toResult(row: typeof uptimeResults.$inferSelect): CheckResult {
  return {
    monitorId: row.monitorId,
    vantageId: row.vantageId,
    at: row.at.getTime(),
    ok: row.ok,
    latencyMs: row.latencyMs,
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.error ? { error: row.error as CheckResult["error"] } : {}),
    ...(row.certDaysLeft !== null ? { certDaysLeft: row.certDaysLeft } : {}),
  };
}

export function buildCheck(input: CreateMonitorInput, previous?: Check): Check {
  const type = input.type ?? previous?.type;
  if (type === "http") {
    const prev = previous?.type === "http" ? previous : undefined;
    const url = input.url ?? prev?.url;
    if (!url) throw new UptimeInputError("Enter a URL.");
    const expectedStatus = input.expectedStatus ?? prev?.expectedStatus ?? { ...DEFAULT_EXPECTED_STATUS };
    if (expectedStatus.max < expectedStatus.min) throw new UptimeInputError("The status range ends before it starts.");
    const keyword = "keyword" in input ? input.keyword || undefined : prev?.keyword;
    return {
      type: "http",
      url,
      expectedStatus,
      ...(keyword ? { keyword } : {}),
      timeoutMs: input.timeoutMs ?? prev?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    };
  }
  if (type === "tcp" || type === "tls") {
    const prev = previous && previous.type !== "http" ? previous : undefined;
    const host = input.host ?? prev?.host;
    if (!host) throw new UptimeInputError("Enter a host.");
    const port = input.port ?? prev?.port ?? (type === "tls" ? DEFAULT_TLS_PORT : undefined);
    if (!port) throw new UptimeInputError("Enter a port.");
    if (type === "tcp") return { type: "tcp", host, port };
    const warnDays = input.warnDays ?? (previous?.type === "tls" ? previous.warnDays : DEFAULT_TLS_WARN_DAYS);
    return { type: "tls", host, port, warnDays };
  }
  throw new UptimeInputError("Choose a check type.");
}

function defaultName(check: Check): string {
  if (check.type !== "http") return `${check.host}:${check.port}`;
  try {
    return new URL(check.url).host;
  } catch {
    return check.url;
  }
}

export async function ownedRow(scope: Scope, id: string): Promise<UptimeMonitorRow | null> {
  const row = await db.query.uptimeMonitors.findFirst({ where: and(eq(uptimeMonitors.id, id), scopeWhere(scope)) });
  return row ?? null;
}

type Loaded = {
  rows: UptimeMonitorRow[];
  vantages: VantagePoint[];
  recent: Map<string, CheckResult[]>;
  daily: Map<string, Bucket[]>;
};

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

const todayStart = (now: number) => Math.floor(now / DAY_MS) * DAY_MS;

async function dailyBuckets(ids: string[], days: number, now: number): Promise<Map<string, Bucket[]>> {
  const from = todayStart(now) - (days - 1) * DAY_MS;
  const rows = ids.length
    ? await db
        .select()
        .from(uptimeDaily)
        .where(and(inArray(uptimeDaily.monitorId, ids), gte(uptimeDaily.start, new Date(from))))
    : [];
  const by = groupBy(rows, (r) => r.monitorId);
  return new Map(
    ids.map((id) => {
      const buckets: Bucket[] = (by.get(id) ?? []).map((r) => bucketOf(r));
      return [id, fillDays(buckets, from, days)];
    }),
  );
}

function bucketOf(r: { start: Date; minutesUp: number; minutesDown: number; minutesUnknown: number; medianLatencyMs: number | null }): Bucket {
  const known = r.minutesUp + r.minutesDown;
  return {
    start: r.start.getTime(),
    minutesUp: r.minutesUp,
    minutesDown: r.minutesDown,
    minutesUnknown: r.minutesUnknown,
    uptimePct: known === 0 ? null : Math.round((r.minutesUp / known) * 10_000) / 100,
    medianLatencyMs: r.medianLatencyMs,
  };
}

const tick = (b: Bucket): DayTick => ({
  start: b.start,
  minutesUp: b.minutesUp,
  minutesDown: b.minutesDown,
  minutesUnknown: b.minutesUnknown,
  uptimePct: b.uptimePct,
});

async function load(rows: UptimeMonitorRow[], now: number): Promise<Loaded> {
  const ids = rows.map((r) => r.id);
  const [vantages, resultRows, daily] = await Promise.all([
    listVantagePoints(),
    ids.length
      ? db
          .select()
          .from(uptimeResults)
          .where(and(inArray(uptimeResults.monitorId, ids), gte(uptimeResults.at, new Date(now - 15 * MINUTE_MS))))
      : Promise.resolve([]),
    dailyBuckets(ids, 30, now),
  ]);
  return { rows, vantages, recent: groupBy(resultRows.map(toResult), (r) => r.monitorId), daily };
}

function summarizeRow(row: UptimeMonitorRow, ctx: Loaded, now: number): MonitorSummary {
  const results = ctx.recent.get(row.id) ?? [];
  const evaluation: Evaluation = evaluate({ vantages: ctx.vantages, results, now, intervalSec: row.intervalSec });
  const daily = ctx.daily.get(row.id) ?? [];
  const last = results.reduce<CheckResult | null>((best, r) => (!best || r.at > best.at ? r : best), null);
  const check = row.check;
  return {
    id: row.id,
    name: row.name,
    target: targetOf(check),
    check,
    intervalSec: row.intervalSec as MonitorSummary["intervalSec"],
    muted: row.muted,
    enabled: row.enabled,
    source: row.source === "auto" ? "auto" : "manual",
    preview: row.preview,
    appId: row.appId,
    domainId: row.domainId,
    maintenance: row.maintenance,
    state: row.enabled ? evaluation.state : "unknown",
    localOnly: evaluation.localOnly,
    downSince: evaluation.downSince ?? null,
    uptime30: rangeUptime(daily),
    daily: daily.map(tick),
    latencyMs: last?.ok ? last.latencyMs : null,
    lastCheckedAt: last?.at ?? null,
  };
}

export async function listMonitors(scope: Scope, now = Date.now()): Promise<MonitorSummary[]> {
  const rows = await db.select().from(uptimeMonitors).where(scopeWhere(scope)).orderBy(asc(uptimeMonitors.name));
  const ctx = await load(rows, now);
  return rows.map((r) => summarizeRow(r, ctx, now));
}

async function channelNames(scope: Scope): Promise<string[]> {
  if (scope.kind !== "org") return [];
  const rows = await db.query.notificationChannels.findMany({
    where: and(eq(notificationChannels.organizationId, scope.orgId), eq(notificationChannels.enabled, true)),
    columns: { name: true, subscribedEvents: true },
  });
  return rows.filter((c) => c.subscribedEvents.length === 0 || c.subscribedEvents.includes("system.service-down")).map((c) => c.name);
}

function latencySeries(results: CheckResult[], vantages: VantagePoint[]): LatencySeries[] {
  const slot = 5 * MINUTE_MS;
  return vantages
    .map((v) => {
      const mine = results.filter((r) => r.vantageId === v.id && r.ok);
      const by = new Map<number, number[]>();
      for (const r of mine) {
        const key = Math.floor(r.at / slot) * slot;
        const list = by.get(key);
        if (list) list.push(r.latencyMs);
        else by.set(key, [r.latencyMs]);
      }
      const points = [...by]
        .sort((a, b) => a[0] - b[0])
        .map(([at, values]) => ({ at, ms: median(values) ?? 0 }));
      return { vantageId: v.id, name: v.name, points };
    })
    .filter((s) => s.points.length > 0);
}

async function outagesFor(scope: Scope, row: UptimeMonitorRow, results: CheckResult[], vantages: VantagePoint[], now: number): Promise<OutageView[]> {
  const from = now - RESULT_RETENTION_DAYS * DAY_MS;
  const found = findOutages({ results, vantages, intervalSec: row.intervalSec, from, to: now });
  const orgId = scope.kind === "org" ? scope.orgId : (await adminOrgIds())[0];
  const incidents = orgId ? await listUptimeIncidents(orgId, row.id, new Date(from)) : [];
  return found
    .map((o) => {
      const incident = incidents.find((i) => {
        const opened = i.openedAt.getTime();
        return opened >= o.start - 5 * MINUTE_MS && opened <= (o.end ?? now) + 5 * MINUTE_MS;
      });
      return { start: o.start, end: o.end, durationMs: (o.end ?? now) - o.start, incidentId: incident?.id ?? null };
    })
    .reverse();
}

export async function getMonitor(scope: Scope, id: string, now = Date.now()): Promise<MonitorDetail | null> {
  const row = await ownedRow(scope, id);
  if (!row) return null;
  const since24 = new Date(now - DAY_MS);
  const [ctx, daily90, hourly, rawRows, channels] = await Promise.all([
    load([row], now),
    dailyBuckets([id], 90, now),
    db
      .select()
      .from(uptimeHourly)
      .where(and(eq(uptimeHourly.monitorId, id), gte(uptimeHourly.start, new Date(Math.floor((now - DAY_MS) / HOUR_MS) * HOUR_MS))))
      .orderBy(desc(uptimeHourly.start)),
    db
      .select()
      .from(uptimeResults)
      .where(and(eq(uptimeResults.monitorId, id), gte(uptimeResults.at, new Date(now - RESULT_RETENTION_DAYS * DAY_MS))))
      .orderBy(asc(uptimeResults.at)),
    channelNames(scope),
  ]);
  const summary = summarizeRow(row, ctx, now);
  const results = rawRows.map(toResult);
  const results24 = results.filter((r) => r.at >= since24.getTime());
  const days90 = daily90.get(id) ?? [];
  const evaluation = evaluate({ vantages: ctx.vantages, results: results.filter((r) => r.at >= now - 15 * MINUTE_MS), now, intervalSec: row.intervalSec });
  const signed = hourly.find((h) => h.signedAt)?.signedAt?.getTime() ?? null;

  const vantages: VantageStateView[] = evaluation.vantages.map((s) => ({
    id: s.vantage.id,
    name: s.vantage.name,
    kind: s.vantage.kind,
    location: s.vantage.location ?? null,
    state: s.state,
    lastResult: s.last
      ? { at: s.last.at, ok: s.last.ok, latencyMs: s.last.latencyMs, status: s.last.status ?? null, error: s.last.error ?? null }
      : null,
    signedAt: s.vantage.kind === "local" ? signed : null,
  }));

  return {
    ...summary,
    uptime24h: rangeUptime(hourly.map(bucketOf)),
    uptime90d: rangeUptime(days90),
    daily90: days90.map(tick),
    medianLatency24h: median(results24.filter((r) => r.ok).map((r) => r.latencyMs)),
    latency24h: latencySeries(results24, ctx.vantages),
    vantages,
    outages: await outagesFor(scope, row, results, ctx.vantages, now),
    channels,
  };
}

export async function createMonitor(scope: Scope, input: CreateMonitorInput): Promise<MonitorSummary> {
  const check = buildCheck(input);
  const id = `mon_${nanoid(16)}`;
  await db.insert(uptimeMonitors).values({
    id,
    organizationId: scope.kind === "org" ? scope.orgId : null,
    name: input.name || defaultName(check),
    check,
    intervalSec: input.intervalSec ?? DEFAULT_INTERVAL,
    source: "manual",
  });
  return (await listMonitorById(scope, id))!;
}

async function listMonitorById(scope: Scope, id: string): Promise<MonitorSummary | null> {
  const row = await ownedRow(scope, id);
  if (!row) return null;
  const now = Date.now();
  return summarizeRow(row, await load([row], now), now);
}

/** Auto monitors change only their enabled, muted and maintenance fields. */
export async function updateMonitor(scope: Scope, id: string, patch: UpdateMonitorInput): Promise<MonitorSummary | null> {
  const row = await ownedRow(scope, id);
  if (!row) return null;
  const set: Partial<typeof uptimeMonitors.$inferInsert> = { updatedAt: new Date() };
  if (patch.muted !== undefined) set.muted = patch.muted;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.maintenance !== undefined) set.maintenance = patch.maintenance;

  const editsCheck = ["type", "name", "url", "host", "port", "expectedStatus", "timeoutMs", "keyword", "warnDays", "intervalSec"].some((k) => k in patch);
  if (editsCheck) {
    if (row.source === "auto") throw new UptimeInputError("Automatic monitors can only be turned off, muted or put in maintenance.");
    if (patch.name !== undefined) set.name = patch.name || defaultName(row.check);
    if (patch.intervalSec !== undefined) set.intervalSec = patch.intervalSec;
    const touched = ["type", "url", "host", "port", "expectedStatus", "timeoutMs", "keyword", "warnDays"].some((k) => k in patch);
    if (touched) {
      const type = patch.type ?? row.check.type;
      set.check = buildCheck({ ...patch, type } as CreateMonitorInput, type === row.check.type ? row.check : undefined);
    }
  }
  await db.update(uptimeMonitors).set(set).where(eq(uptimeMonitors.id, id));
  return listMonitorById(scope, id);
}

export async function setMuted(scope: Scope, id: string, muted: boolean): Promise<MonitorSummary | null> {
  return updateMonitor(scope, id, { muted });
}

/** Manual monitors are deleted. Automatic ones stay; turn them off instead. */
export async function deleteMonitor(scope: Scope, id: string): Promise<"deleted" | "auto" | "missing"> {
  const row = await ownedRow(scope, id);
  if (!row) return "missing";
  if (row.source === "auto") return "auto";
  await db.delete(uptimeMonitors).where(eq(uptimeMonitors.id, id));
  return "deleted";
}

export async function getAppUptime(orgId: string, appId: string, now = Date.now()): Promise<AppUptime> {
  const scope: Scope = { kind: "org", orgId };
  const rows = await db
    .select()
    .from(uptimeMonitors)
    .where(and(scopeWhere(scope), eq(uptimeMonitors.appId, appId)))
    .orderBy(asc(uptimeMonitors.preview), asc(uptimeMonitors.name));
  const ctx = await load(rows, now);
  const monitors = rows.map((r) => summarizeRow(r, ctx, now));
  const active = monitors.filter((m) => m.enabled);

  const ids = active.map((m) => m.id);
  const [daily90, hourly, raw] = await Promise.all([
    dailyBuckets(ids, 90, now),
    ids.length
      ? db
          .select()
          .from(uptimeHourly)
          .where(and(inArray(uptimeHourly.monitorId, ids), gte(uptimeHourly.start, new Date(Math.floor((now - DAY_MS) / HOUR_MS) * HOUR_MS))))
      : Promise.resolve([]),
    ids.length
      ? db
          .select()
          .from(uptimeResults)
          .where(and(inArray(uptimeResults.monitorId, ids), gte(uptimeResults.at, new Date(now - RESULT_RETENTION_DAYS * DAY_MS))))
      : Promise.resolve([]),
  ]);

  // The app's days combine its monitors' days.
  const merged = (days: number): Bucket[] => {
    const lists = ids.map((id) => daily90.get(id) ?? []);
    const from = todayStart(now) - (days - 1) * DAY_MS;
    return Array.from({ length: days }, (_, i) => {
      const start = from + i * DAY_MS;
      const day = lists.map((l) => l.find((b) => b.start === start)).filter((b): b is Bucket => !!b);
      return day.length ? combine(day, start) : fillDays([], start, 1)[0];
    });
  };
  const days90 = merged(90);

  const results = raw.map(toResult);
  const byMonitor = groupBy(results, (r) => r.monitorId);
  const outages = active.flatMap((m) =>
    findOutages({ results: byMonitor.get(m.id) ?? [], vantages: ctx.vantages, intervalSec: m.intervalSec, from: now - RESULT_RETENTION_DAYS * DAY_MS, to: now }),
  );
  const lastOutage = outages.sort((a, b) => b.start - a.start)[0] ?? null;
  const downs = active.filter((m) => m.state === "down");
  const known = active.filter((m) => m.state !== "unknown");
  const lastCheckedAt = active.reduce<number | null>((best, m) => (m.lastCheckedAt && (!best || m.lastCheckedAt > best) ? m.lastCheckedAt : best), null);

  return {
    monitors,
    state: downs.length ? "down" : known.length ? "up" : "unknown",
    localOnly: active.every((m) => m.localOnly),
    downSince: downs.length ? Math.min(...downs.map((m) => m.downSince ?? now)) : null,
    lastCheckedAt,
    vantageName: ctx.vantages[0]?.name ?? null,
    uptime24h: rangeUptime(hourly.map(bucketOf)),
    uptime30d: rangeUptime(days90.slice(-30)),
    uptime90d: rangeUptime(days90),
    daily90: days90.map(tick),
    medianLatency24h: median(results.filter((r) => r.ok && r.at >= now - DAY_MS).map((r) => r.latencyMs)),
    lastOutage,
  };
}

/** Vantage points as the UI names them. */
export async function listVantages() {
  const points = await listVantagePoints();
  return points.map((p) => ({ id: p.id, name: p.name, kind: p.kind, location: p.location ?? null }));
}
