// Uptime service: monitors and their state, read from the tables. Callers check access first.

import { and, asc, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import {
  apps,
  domains,
  notificationChannels,
  uptimeDaily,
  uptimeHourly,
  uptimeMonitors,
  uptimeRecords,
  uptimeResults,
  uptimeVantages,
  type UptimeMonitorRow,
} from "@/lib/db/schema";
import { getInstanceDisplayName } from "@/lib/system-settings";
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
  RANGE_SPECS,
  REPORT_ACCEPTED_FRESH_MS,
  bucketStarts,
  combine,
  defaultRange,
  effectiveIntervalSec,
  evaluate,
  fillBuckets,
  fillDays,
  summarize,
  trimToHistory,
  type UptimeRange,
  markImpaired,
  findOutages,
  median,
  rangeUptime,
  type Bucket,
  type Check,
  type CheckPath,
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
import { UptimeInputError } from "./errors";
import { vantageNames } from "./format";
import { targetRefusal, type PolicyLevel } from "./outbound";
import { autoCheckFor, autoEdit, baseUrlOf, editsAuto } from "./auto";
import { applyHeaderPatch } from "./secrets";
import { listVantagePoints } from "./vantage";
import { externalWatchers, loadImpaired, sharing } from "./watchers";

const MINUTE_MS = 60_000;
const RESULT_RETENTION_DAYS = 14;

export { UptimeInputError };

export function scopeWhere(scope: Scope) {
  return scope.kind === "org" ? eq(uptimeMonitors.organizationId, scope.orgId) : isNull(uptimeMonitors.organizationId);
}

export function targetOf(check: Check): string {
  return check.type === "http" ? check.url : `${check.host}:${check.port}`;
}

export function toResult(row: typeof uptimeResults.$inferSelect): CheckResult {
  return {
    monitorId: row.monitorId,
    vantageId: row.vantageId,
    path: row.path as CheckPath,
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

export type Loaded = {
  rows: UptimeMonitorRow[];
  watchers: Map<string, string[]>;
  impaired: Set<string>;
  appNames: Map<string, string>;
  /** Domains that still exist among those manual checks link to. */
  liveDomains: Set<string>;
  vantages: VantagePoint[];
  recent: Map<string, CheckResult[]>;
  daily: Map<string, Bucket[]>;
  range: UptimeRange;
  /** Bars for the range, from where each monitor's history starts. */
  bars: Map<string, { buckets: Bucket[]; since: number | null }>;
  /** This instance's name and the linked instances that took its last report, with the monitors in it. */
  reports: { by: string; to: { name: string; ids: Set<string> }[] };
};

async function reportsTaken(now: number): Promise<Loaded["reports"]> {
  const [rows, by] = await Promise.all([
    db
      .select({ name: uptimeVantages.name, reporting: uptimeVantages.reporting })
      .from(uptimeVantages)
      .where(and(eq(uptimeVantages.kind, "external"), gte(uptimeVantages.reportedAt, new Date(now - REPORT_ACCEPTED_FRESH_MS)))),
    getInstanceDisplayName().catch(() => null),
  ]);
  return { by: by || "this instance", to: rows.map((r) => ({ name: r.name, ids: new Set(r.reporting) })) };
}

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

/** Bars for each monitor over a range: raw results for an hour, hourly rollups for a day or a week, daily rollups beyond. */
async function rangeBars(rows: UptimeMonitorRow[], range: UptimeRange, now: number, ctx: Pick<Loaded, "vantages" | "impaired" | "watchers" | "daily">): Promise<Map<string, { buckets: Bucket[]; since: number | null }>> {
  const { bucketMs } = RANGE_SPECS[range];
  const starts = bucketStarts(range, now);
  const ids = rows.map((r) => r.id);
  const out = new Map<string, { buckets: Bucket[]; since: number | null }>();
  const finish = (row: UptimeMonitorRow, buckets: Bucket[]) => out.set(row.id, trimToHistory(fillBuckets(buckets, starts, bucketMs), bucketMs, row.createdAt.getTime()));
  if (ids.length === 0) return out;

  if (range === "1h") {
    const raw = await db.select().from(uptimeResults).where(and(inArray(uptimeResults.monitorId, ids), gte(uptimeResults.at, new Date(starts[0] - 10 * MINUTE_MS))));
    const by = groupBy(raw.map(toResult), (r) => r.monitorId);
    for (const row of rows) {
      const results = markImpaired(by.get(row.id) ?? [], ctx.impaired);
      finish(row, summarize({ results, vantages: ctx.vantages, intervalSec: periodOf(row, ctx), from: starts[0], to: now, bucketMs }));
    }
  } else if (range === "24h" || range === "7d") {
    const hourly = await db.select().from(uptimeHourly).where(and(inArray(uptimeHourly.monitorId, ids), gte(uptimeHourly.start, new Date(starts[0]))));
    const by = groupBy(hourly, (h) => h.monitorId);
    for (const row of rows) {
      const groups = groupBy((by.get(row.id) ?? []).map(bucketOf), (b) => String(Math.floor(b.start / bucketMs) * bucketMs));
      finish(row, [...groups].map(([start, list]) => combine(list, Number(start))));
    }
  } else {
    const days = await dailyBuckets(ids, range === "30d" ? 30 : 90, now);
    for (const row of rows) finish(row, days.get(row.id) ?? []);
  }
  return out;
}

export async function load(rows: UptimeMonitorRow[], now: number, range?: UptimeRange): Promise<Loaded> {
  const effective = range ?? defaultRange(rows.length ? now - Math.min(...rows.map((r) => r.createdAt.getTime())) : 0);
  const ids = rows.map((r) => r.id);
  const appIds = [...new Set(rows.map((r) => r.appId).filter((id): id is string => !!id))];
  const linkedIds = [...new Set(rows.map((r) => r.linkDomainId).filter((id): id is string => !!id))];
  const [vantages, resultRows, daily, appRows, watchers, impaired, domainRows, reports] = await Promise.all([
    listVantagePoints(),
    ids.length
      ? db
          .select()
          .from(uptimeResults)
          .where(and(inArray(uptimeResults.monitorId, ids), gte(uptimeResults.at, new Date(now - 15 * MINUTE_MS))))
      : Promise.resolve([]),
    dailyBuckets(ids, 30, now),
    appIds.length ? db.select({ id: apps.id, name: apps.name }).from(apps).where(inArray(apps.id, appIds)) : Promise.resolve([]),
    externalWatchers(),
    loadImpaired(now),
    linkedIds.length ? db.select({ id: domains.id }).from(domains).where(inArray(domains.id, linkedIds)) : Promise.resolve([]),
    reportsTaken(now),
  ]);
  const partial = { vantages, impaired, watchers, daily };
  const bars = await rangeBars(rows, effective, now, partial);
  return { rows, range: effective, bars, reports, watchers, impaired, appNames: new Map(appRows.map((a) => [a.id, a.name])), liveDomains: new Set(domainRows.map((d) => d.id)), vantages, recent: groupBy(resultRows.map(toResult), (r) => r.monitorId), daily };
}

/** How often each vantage point checks the monitor, counting those that share it. */
const periodOf = (row: UptimeMonitorRow, ctx: Pick<Loaded, "watchers">) => effectiveIntervalSec(row.intervalSec, sharing(ctx.watchers, row.id).length);

function reportOf(id: string, ctx: Loaded): MonitorSummary["report"] {
  const to = [...new Set(ctx.reports.to.filter((v) => v.ids.has(id)).map((v) => v.name))];
  return to.length > 0 ? { by: ctx.reports.by, to } : null;
}

export function summarizeRow(row: UptimeMonitorRow, ctx: Loaded, now: number): MonitorSummary {
  const results = ctx.recent.get(row.id) ?? [];
  const evaluation: Evaluation = evaluate({ vantages: ctx.vantages, results, now, intervalSec: periodOf(row, ctx), impaired: ctx.impaired });
  const daily = ctx.daily.get(row.id) ?? [];
  const last = results.reduce<CheckResult | null>((best, r) => (!best || r.at > best.at ? r : best), null);
  const check = row.check;
  const reviewing = row.enabled && row.reviewStatus !== null && row.reviewAnswer === null;
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
    appName: row.appId ? (ctx.appNames.get(row.appId) ?? null) : null,
    domainId: row.domainId ?? row.linkDomainId,
    domainRemoved: !!row.linkDomainId && !ctx.liveDomains.has(row.linkDomainId),
    createdAt: row.createdAt.getTime(),
    overrides: row.overrides,
    healthPath: row.healthPath,
    healthSource: (row.healthSource as MonitorSummary["healthSource"]) ?? null,
    review: reviewing ? { status: row.reviewStatus!, reason: row.reviewReason === "login" ? "login" : "status" } : null,
    reviewAnswer: row.reviewAnswer,
    headers: row.headerNames,
    shareHeaders: row.shareHeaders,
    privateHeader: row.headerNames.length > 0 && !row.shareHeaders,
    maintenance: row.maintenance,
    state: !row.enabled ? "unknown" : reviewing ? "review" : evaluation.state,
    openable: check.type === "http" && row.peerRole !== "link",
    reading: row.enabled && !reviewing ? (evaluation.reading ?? null) : null,
    report: reportOf(row.id, ctx),
    localOnly: evaluation.localOnly,
    downSince: evaluation.downSince ?? null,
    uptime30: rangeUptime(daily),
    daily: daily.map(tick),
    range: ctx.range,
    bars: (ctx.bars.get(row.id)?.buckets ?? []).map(tick),
    barMs: RANGE_SPECS[ctx.range].bucketMs,
    since: ctx.bars.get(row.id)?.since ?? null,
    rangeUptime: rangeUptime(ctx.bars.get(row.id)?.buckets ?? []),
    latencyMs: last?.ok ? last.latencyMs : null,
    lastCheckedAt: last?.at ?? null,
  };
}

export async function listMonitors(scope: Scope, now = Date.now(), range?: UptimeRange): Promise<MonitorSummary[]> {
  const rows = await db.select().from(uptimeMonitors).where(scopeWhere(scope)).orderBy(asc(uptimeMonitors.name));
  const ctx = await load(rows, now, range);
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

async function outagesFor(scope: Scope, row: UptimeMonitorRow, results: CheckResult[], vantages: VantagePoint[], watchers: number, now: number): Promise<OutageView[]> {
  const from = now - RESULT_RETENTION_DAYS * DAY_MS;
  const found = findOutages({ results, vantages, intervalSec: effectiveIntervalSec(row.intervalSec, watchers), from, to: now });
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

export async function getMonitor(scope: Scope, id: string, now = Date.now(), range?: UptimeRange): Promise<MonitorDetail | null> {
  const row = await ownedRow(scope, id);
  if (!row) return null;
  const since24 = new Date(now - DAY_MS);
  const [ctx, daily90, hourly, rawRows, channels] = await Promise.all([
    load([row], now, range),
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
  const results = markImpaired(rawRows.map(toResult), ctx.impaired);
  const results24 = results.filter((r) => r.at >= since24.getTime());
  const days90 = daily90.get(id) ?? [];
  const evaluation = evaluate({ vantages: ctx.vantages, results: results.filter((r) => r.at >= now - 15 * MINUTE_MS), now, intervalSec: periodOf(row, ctx), impaired: ctx.impaired });
  const signed = hourly.find((h) => h.signedAt)?.signedAt?.getTime() ?? null;
  const received = await latestSummaries(id);
  const outages = await outagesFor(scope, row, results, ctx.vantages, sharing(ctx.watchers, row.id).length, now);
  const ongoing = outages.find((o) => o.end === null);
  if (ongoing && summary.downSince) Object.assign(ongoing, { start: summary.downSince, durationMs: now - summary.downSince });

  const vantages: VantageStateView[] = evaluation.vantages.map((s) => ({
    id: s.vantage.id,
    name: s.vantage.name,
    kind: s.vantage.kind,
    location: s.vantage.location ?? null,
    path: s.path,
    state: s.state,
    lastResult: s.last
      ? { at: s.last.at, ok: s.last.ok, latencyMs: s.last.latencyMs, status: s.last.status ?? null, error: s.last.error ?? null }
      : null,
    signedAt: s.vantage.kind === "local" ? signed : (received.get(s.vantage.id) ?? null),
  }));

  return {
    ...summary,
    uptime24h: rangeUptime(hourly.map(bucketOf)),
    uptime90d: rangeUptime(days90),
    daily90: days90.map(tick),
    medianLatency24h: median(results24.filter((r) => r.ok).map((r) => r.latencyMs)),
    latency24h: latencySeries(results24, ctx.vantages),
    vantages,
    outages,
    channels,
  };
}

/** Refuses a manual org monitor aimed at a private, loopback, link-local or mesh address. */
async function assertTargetAllowed(scope: Scope, check: Check): Promise<void> {
  const level: PolicyLevel = scope.kind === "org" ? "strict" : "operator";
  const reason = await targetRefusal(check, level);
  if (reason) throw new UptimeInputError(`That address isn't allowed for monitors: ${reason}.`);
}

export async function createMonitor(scope: Scope, input: CreateMonitorInput): Promise<MonitorSummary> {
  const check = buildCheck(input);
  await assertTargetAllowed(scope, check);
  const id = `mon_${nanoid(16)}`;
  const organizationId = scope.kind === "org" ? scope.orgId : null;
  const link: Partial<typeof uptimeMonitors.$inferInsert> = {};
  if (input.appId) {
    if (scope.kind !== "org") throw new UptimeInputError("Only an org's monitors link to an app.");
    const app = await db.query.apps.findFirst({ where: and(eq(apps.id, input.appId), eq(apps.organizationId, scope.orgId)), columns: { id: true } });
    if (!app) throw new UptimeInputError("That app doesn't exist.");
    link.appId = app.id;
    if (input.domainId) {
      const domain = await db.query.domains.findFirst({ where: and(eq(domains.id, input.domainId), eq(domains.appId, app.id)), columns: { id: true, domain: true } });
      if (!domain) throw new UptimeInputError("That domain isn't on the app.");
      link.linkDomainId = domain.id;
      link.linkDomain = domain.domain;
    }
  } else if (input.domainId) {
    throw new UptimeInputError("Choose the app the domain belongs to.");
  }
  const wantsHeaders = !!(input.headers?.length || input.basicAuth);
  if (wantsHeaders && check.type !== "http") throw new UptimeInputError("Headers apply to HTTP checks only.");
  const headers = wantsHeaders ? applyHeaderPatch(null, { organizationId }, input) : null;
  await db.insert(uptimeMonitors).values({
    id,
    organizationId,
    ...link,
    ...(headers ? { headersEncrypted: headers.sealed, headerNames: headers.names, shareHeaders: input.shareHeaders ?? false } : {}),
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

  if (patch.headers !== undefined || patch.basicAuth !== undefined || patch.shareHeaders !== undefined) {
    if (row.check.type !== "http") throw new UptimeInputError("Headers apply to HTTP checks only.");
    if (patch.headers !== undefined || patch.basicAuth !== undefined) {
      const next = applyHeaderPatch(row.headersEncrypted, row, patch);
      set.headersEncrypted = next.sealed;
      set.headerNames = next.names;
      // New headers can change what an automatic monitor sees.
      if (row.source === "auto") set.healthDueAt = null;
    }
    if (patch.shareHeaders !== undefined) set.shareHeaders = patch.shareHeaders;
  }

  if (row.source === "auto" && editsAuto(patch)) {
    const changes = autoEdit(row, patch);
    Object.assign(set, changes);
    const base = baseUrlOf(row);
    if (base && row.check.type === "http") {
      const next = autoCheckFor({ healthPath: changes.healthPath === undefined ? row.healthPath : changes.healthPath, reviewAnswer: "reviewAnswer" in changes ? (changes.reviewAnswer ?? null) : row.reviewAnswer, overrides: "overrides" in changes ? (changes.overrides ?? null) : row.overrides }, base);
      set.check = { ...row.check, url: next.url, expectedStatus: next.expectedStatus, timeoutMs: next.timeoutMs, keyword: next.keyword };
    }
  }

  const editsCheck = row.source !== "auto" ? ["type", "name", "url", "host", "port", "expectedStatus", "timeoutMs", "keyword", "warnDays", "intervalSec"].some((k) => k in patch) : ["type", "url", "host", "port", "warnDays"].some((k) => k in patch);
  if (editsCheck) {
    if (row.source === "auto") throw new UptimeInputError("An automatic monitor's address follows its domain. Change the path instead.");
    if (patch.name !== undefined) set.name = patch.name || defaultName(row.check);
    if (patch.intervalSec !== undefined) set.intervalSec = patch.intervalSec;
    const touched = ["type", "url", "host", "port", "expectedStatus", "timeoutMs", "keyword", "warnDays"].some((k) => k in patch);
    if (touched) {
      const type = patch.type ?? row.check.type;
      set.check = buildCheck({ ...patch, type } as CreateMonitorInput, type === row.check.type ? row.check : undefined);
      await assertTargetAllowed(scope, set.check);
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

export async function getAppUptime(orgId: string, appId: string, now = Date.now(), range?: UptimeRange): Promise<AppUptime> {
  const scope: Scope = { kind: "org", orgId };
  // A compose stack's services carry the domains.
  const stack = await db.select({ id: apps.id }).from(apps).where(and(eq(apps.organizationId, orgId), or(eq(apps.id, appId), eq(apps.parentAppId, appId))));
  const rows = await db
    .select()
    .from(uptimeMonitors)
    .where(and(scopeWhere(scope), inArray(uptimeMonitors.appId, stack.map((a) => a.id))))
    .orderBy(asc(uptimeMonitors.preview), asc(uptimeMonitors.name));
  const ctx = await load(rows, now, range);
  const monitors = rows.map((r) => summarizeRow(r, ctx, now));
  const active = monitors.filter((m) => m.enabled);

  // The app's bars combine its monitors', from where the oldest one's history starts.
  const { bucketMs } = RANGE_SPECS[ctx.range];
  const starts = bucketStarts(ctx.range, now);
  const historyStart = active.length ? Math.min(...active.map((m) => m.createdAt)) : null;
  const barsOf = (id: string) => new Map((ctx.bars.get(id)?.buckets ?? []).map((b) => [b.start, b]));
  const monitorBars = active.map((m) => barsOf(m.id));
  const combined = starts.map((start) => {
    const parts = monitorBars.map((m) => m.get(start)).filter((b): b is Bucket => !!b);
    return parts.length ? combine(parts, start) : null;
  });
  const appBars = trimToHistory(fillBuckets(combined.filter((b): b is Bucket => !!b), starts, bucketMs), bucketMs, historyStart);

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

  const results = markImpaired(raw.map(toResult), ctx.impaired);
  const byMonitor = groupBy(results, (r) => r.monitorId);
  const outages = active.flatMap((m) =>
    findOutages({ results: byMonitor.get(m.id) ?? [], vantages: ctx.vantages, intervalSec: effectiveIntervalSec(m.intervalSec, sharing(ctx.watchers, m.id).length), from: now - RESULT_RETENTION_DAYS * DAY_MS, to: now }),
  );
  const lastOutage = outages.sort((a, b) => b.start - a.start)[0] ?? null;
  const downs = active.filter((m) => m.state === "down");
  const degraded = active.filter((m) => m.state === "degraded");
  const reviews = active.filter((m) => m.state === "review");
  const known = active.filter((m) => m.state === "up" || m.state === "degraded" || m.state === "down");
  const lastCheckedAt = active.reduce<number | null>((best, m) => (m.lastCheckedAt && (!best || m.lastCheckedAt > best) ? m.lastCheckedAt : best), null);

  return {
    monitors,
    range: ctx.range,
    bars: appBars.buckets.map(tick),
    barMs: bucketMs,
    since: appBars.since,
    rangeUptime: rangeUptime(appBars.buckets),
    historyStart,
    reviews,
    state: downs.length ? "down" : degraded.length ? "degraded" : known.length ? "up" : "unknown",
    localOnly: active.every((m) => m.localOnly),
    downSince: downs.length ? Math.min(...downs.map((m) => m.downSince ?? now)) : null,
    reading: (downs[0] ?? degraded[0])?.reading ?? null,
    lastCheckedAt,
    vantageName: vantageNames(ctx.vantages),
    uptime24h: rangeUptime(hourly.map(bucketOf)),
    uptime30d: rangeUptime(days90.slice(-30)),
    uptime90d: rangeUptime(days90),
    daily90: days90.map(tick),
    medianLatency24h: median(results.filter((r) => r.ok && r.at >= now - DAY_MS).map((r) => r.latencyMs)),
    lastOutage,
  };
}

/** Epoch ms of the newest hourly summary each external vantage point signed for a monitor. */
async function latestSummaries(monitorId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ vantageId: uptimeRecords.vantageId, issuedAt: uptimeRecords.issuedAt })
    .from(uptimeRecords)
    .where(and(eq(uptimeRecords.kind, "hourly"), eq(uptimeRecords.monitorId, monitorId)))
    .orderBy(desc(uptimeRecords.issuedAt))
    .limit(50);
  const out = new Map<string, number>();
  for (const r of rows) if (!out.has(r.vantageId)) out.set(r.vantageId, r.issuedAt.getTime());
  return out;
}

/** Vantage points as the UI names them. */
export async function listVantages() {
  const points = await listVantagePoints();
  return points.map((p) => ({ id: p.id, name: p.name, kind: p.kind, location: p.location ?? null }));
}
