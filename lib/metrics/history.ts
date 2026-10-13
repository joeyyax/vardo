// Reads over the hourly per-app rollup: window summaries, hour-of-day profiles and per-day series.
// Rows are UTC hours; profile and day reads take an IANA zone and bucket by each row's local start.

import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { appMetricHours, type AppMetricHourRow } from "@/lib/db/schema";
import { HOUR_MS, addHistograms, emptyHistogram, floorHour, histogramPercentile } from "./rollup-math";

export type HistoryWindow = { from: Date; to: Date };

/** The columns the reads use. */
export type HistoryRow = Pick<
  AppMetricHourRow,
  | "appId"
  | "hour"
  | "metricMinutes"
  | "cpuAvg"
  | "cpuPeak"
  | "memoryAvg"
  | "memoryPeak"
  | "memoryLimit"
  | "networkRxBytes"
  | "networkTxBytes"
  | "checksTotal"
  | "checksUp"
  | "responseCount"
  | "responseMsSum"
  | "responseHistogram"
>;

export type Peak = { value: number; at: Date };

export type Coverage = {
  /** Minutes with container samples. */
  minutes: number;
  /** Minutes in the window's completed hours. */
  expectedMinutes: number;
  /** minutes / expectedMinutes, 0 to 1. */
  ratio: number;
};

export type AppSummary = {
  /** Whole UTC hours: from rounded down, to rounded down. */
  from: Date;
  to: Date;
  hours: number;
  coverage: Coverage;
  /** Averages are over sampled minutes only. Null when nothing was sampled. */
  cpu: { avg: number; peak: Peak } | null;
  memory: { avg: number; peak: Peak; limit: number | null } | null;
  network: { rxBytes: number; txBytes: number } | null;
  uptime: { checks: number; up: number; ratio: number; hoursChecked: number } | null;
  /** Reachable checks only. Percentiles are interpolated inside histogram buckets. */
  response: { count: number; mean: number; p50: number; p95: number } | null;
};

export type HourOfDayBucket = {
  /** Local hour, 0 to 23. */
  hour: number;
  /** Rows with samples that landed on this hour. */
  sampledHours: number;
  /** Means per sampled hour. */
  cpuAvg: number | null;
  memoryAvg: number | null;
  rxBytes: number | null;
  txBytes: number | null;
  checks: number;
  up: number;
};

export type DayPoint = {
  /** Local date, YYYY-MM-DD. */
  date: string;
  coverage: Coverage;
  cpuAvg: number | null;
  cpuPeak: number | null;
  memoryAvg: number | null;
  memoryPeak: number | null;
  rxBytes: number | null;
  txBytes: number | null;
  checks: number;
  up: number;
  uptime: number | null;
  p50: number | null;
  p95: number | null;
};

function normalize(window: HistoryWindow): { fromMs: number; toMs: number } {
  const fromMs = floorHour(window.from.getTime());
  return { fromMs, toMs: Math.max(fromMs, floorHour(window.to.getTime())) };
}

function coverage(minutes: number, hours: number): Coverage {
  const expectedMinutes = hours * 60;
  return { minutes, expectedMinutes, ratio: expectedMinutes > 0 ? Math.min(1, minutes / expectedMinutes) : 0 };
}

type Totals = {
  minutes: number;
  cpuWeighted: number;
  memWeighted: number;
  cpuPeak: Peak | null;
  memPeak: Peak | null;
  limit: number | null;
  rx: number;
  tx: number;
  network: boolean;
  checks: number;
  up: number;
  hoursChecked: number;
  responseCount: number;
  responseSum: number;
  histogram: number[];
};

function totals(rows: HistoryRow[]): Totals {
  const t: Totals = {
    minutes: 0, cpuWeighted: 0, memWeighted: 0, cpuPeak: null, memPeak: null, limit: null,
    rx: 0, tx: 0, network: false, checks: 0, up: 0, hoursChecked: 0,
    responseCount: 0, responseSum: 0, histogram: emptyHistogram(),
  };
  const ordered = [...rows].sort((a, b) => a.hour.getTime() - b.hour.getTime());
  for (const r of ordered) {
    if (r.metricMinutes > 0) {
      t.minutes += r.metricMinutes;
      t.cpuWeighted += (r.cpuAvg ?? 0) * r.metricMinutes;
      t.memWeighted += (r.memoryAvg ?? 0) * r.metricMinutes;
      if (r.cpuPeak !== null && (!t.cpuPeak || r.cpuPeak > t.cpuPeak.value)) t.cpuPeak = { value: r.cpuPeak, at: r.hour };
      if (r.memoryPeak !== null && (!t.memPeak || r.memoryPeak > t.memPeak.value)) t.memPeak = { value: r.memoryPeak, at: r.hour };
      t.limit = r.memoryLimit;
    }
    if (r.networkRxBytes !== null || r.networkTxBytes !== null) {
      t.network = true;
      t.rx += r.networkRxBytes ?? 0;
      t.tx += r.networkTxBytes ?? 0;
    }
    if (r.checksTotal > 0) {
      t.checks += r.checksTotal;
      t.up += r.checksUp;
      t.hoursChecked++;
    }
    t.responseCount += r.responseCount;
    t.responseSum += r.responseMsSum;
    addHistograms(t.histogram, r.responseHistogram);
  }
  return t;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Summary of an app's rows over a window. Rows outside it are ignored. */
export function summarizeHours(rows: HistoryRow[], window: HistoryWindow): AppSummary {
  const { fromMs, toMs } = normalize(window);
  const hours = (toMs - fromMs) / HOUR_MS;
  const t = totals(rows.filter((r) => r.hour.getTime() >= fromMs && r.hour.getTime() < toMs));
  const sampled = t.minutes > 0;
  return {
    from: new Date(fromMs),
    to: new Date(toMs),
    hours,
    coverage: coverage(t.minutes, hours),
    cpu: sampled && t.cpuPeak ? { avg: round2(t.cpuWeighted / t.minutes), peak: t.cpuPeak } : null,
    memory: sampled && t.memPeak ? { avg: Math.round(t.memWeighted / t.minutes), peak: t.memPeak, limit: t.limit } : null,
    network: t.network ? { rxBytes: t.rx, txBytes: t.tx } : null,
    uptime: t.checks > 0 ? { checks: t.checks, up: t.up, ratio: t.up / t.checks, hoursChecked: t.hoursChecked } : null,
    response: t.responseCount > 0
      ? {
          count: t.responseCount,
          mean: Math.round(t.responseSum / t.responseCount),
          p50: histogramPercentile(t.histogram, 0.5)!,
          p95: histogramPercentile(t.histogram, 0.95)!,
        }
      : null,
  };
}

function partsIn(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    hourCycle: "h23",
  });
  return (date: Date) => {
    const parts = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
  };
}

/** 24 local-hour buckets of means per sampled hour, for a busiest-hours strip. */
export function hourOfDay(rows: HistoryRow[], window: HistoryWindow, timeZone = "UTC"): HourOfDayBucket[] {
  const { fromMs, toMs } = normalize(window);
  const local = partsIn(timeZone);
  const acc = Array.from({ length: 24 }, (_, hour) => ({ hour, n: 0, cpu: 0, mem: 0, rx: 0, tx: 0, checks: 0, up: 0 }));
  for (const r of rows) {
    const at = r.hour.getTime();
    if (at < fromMs || at >= toMs) continue;
    const b = acc[local(r.hour).hour]!;
    b.checks += r.checksTotal;
    b.up += r.checksUp;
    if (r.metricMinutes === 0) continue;
    b.n++;
    b.cpu += r.cpuAvg ?? 0;
    b.mem += r.memoryAvg ?? 0;
    b.rx += r.networkRxBytes ?? 0;
    b.tx += r.networkTxBytes ?? 0;
  }
  return acc.map((b) => ({
    hour: b.hour,
    sampledHours: b.n,
    cpuAvg: b.n ? round2(b.cpu / b.n) : null,
    memoryAvg: b.n ? Math.round(b.mem / b.n) : null,
    rxBytes: b.n ? Math.round(b.rx / b.n) : null,
    txBytes: b.n ? Math.round(b.tx / b.n) : null,
    checks: b.checks,
    up: b.up,
  }));
}

/** One point per local day the window touches, empty days included with zero coverage. */
export function dailySeries(rows: HistoryRow[], window: HistoryWindow, timeZone = "UTC"): DayPoint[] {
  const { fromMs, toMs } = normalize(window);
  const local = partsIn(timeZone);
  const days = new Map<string, { hours: number; rows: HistoryRow[] }>();
  for (let at = fromMs; at < toMs; at += HOUR_MS) {
    const key = local(new Date(at)).date;
    const day = days.get(key) ?? { hours: 0, rows: [] };
    day.hours++;
    days.set(key, day);
  }
  for (const r of rows) {
    const at = r.hour.getTime();
    if (at < fromMs || at >= toMs) continue;
    days.get(local(r.hour).date)?.rows.push(r);
  }
  return [...days.entries()].map(([date, day]) => {
    const t = totals(day.rows);
    const sampled = t.minutes > 0;
    return {
      date,
      coverage: coverage(t.minutes, day.hours),
      cpuAvg: sampled ? round2(t.cpuWeighted / t.minutes) : null,
      cpuPeak: t.cpuPeak?.value ?? null,
      memoryAvg: sampled ? Math.round(t.memWeighted / t.minutes) : null,
      memoryPeak: t.memPeak?.value ?? null,
      rxBytes: t.network ? t.rx : null,
      txBytes: t.network ? t.tx : null,
      checks: t.checks,
      up: t.up,
      uptime: t.checks > 0 ? t.up / t.checks : null,
      p50: histogramPercentile(t.histogram, 0.5),
      p95: histogramPercentile(t.histogram, 0.95),
    };
  });
}

const HISTORY_COLUMNS = {
  appId: appMetricHours.appId,
  hour: appMetricHours.hour,
  metricMinutes: appMetricHours.metricMinutes,
  cpuAvg: appMetricHours.cpuAvg,
  cpuPeak: appMetricHours.cpuPeak,
  memoryAvg: appMetricHours.memoryAvg,
  memoryPeak: appMetricHours.memoryPeak,
  memoryLimit: appMetricHours.memoryLimit,
  networkRxBytes: appMetricHours.networkRxBytes,
  networkTxBytes: appMetricHours.networkTxBytes,
  checksTotal: appMetricHours.checksTotal,
  checksUp: appMetricHours.checksUp,
  responseCount: appMetricHours.responseCount,
  responseMsSum: appMetricHours.responseMsSum,
  responseHistogram: appMetricHours.responseHistogram,
};

/** An org's rows in the window, optionally narrowed to some apps. */
export async function loadHistoryRows(
  organizationId: string,
  window: HistoryWindow,
  appIds?: string[],
): Promise<HistoryRow[]> {
  if (appIds && appIds.length === 0) return [];
  const { fromMs, toMs } = normalize(window);
  return db
    .select(HISTORY_COLUMNS)
    .from(appMetricHours)
    .where(
      and(
        eq(appMetricHours.organizationId, organizationId),
        gte(appMetricHours.hour, new Date(fromMs)),
        lt(appMetricHours.hour, new Date(toMs)),
        appIds ? inArray(appMetricHours.appId, appIds) : undefined,
      ),
    )
    .orderBy(asc(appMetricHours.hour));
}

export async function appSummary(organizationId: string, appId: string, window: HistoryWindow): Promise<AppSummary> {
  return summarizeHours(await loadHistoryRows(organizationId, window, [appId]), window);
}

/** Summaries for every app with rows in the window, in one read. Apps with no rows are absent. */
export async function appSummaries(
  organizationId: string,
  window: HistoryWindow,
  appIds?: string[],
): Promise<Map<string, AppSummary>> {
  const byApp = new Map<string, HistoryRow[]>();
  for (const row of await loadHistoryRows(organizationId, window, appIds)) {
    const list = byApp.get(row.appId) ?? [];
    list.push(row);
    byApp.set(row.appId, list);
  }
  return new Map([...byApp].map(([appId, rows]) => [appId, summarizeHours(rows, window)]));
}

export async function appHourOfDay(
  organizationId: string,
  appId: string,
  window: HistoryWindow,
  timeZone?: string,
): Promise<HourOfDayBucket[]> {
  return hourOfDay(await loadHistoryRows(organizationId, window, [appId]), window, timeZone);
}

export async function appDailySeries(
  organizationId: string,
  appId: string,
  window: HistoryWindow,
  timeZone?: string,
): Promise<DayPoint[]> {
  return dailySeries(await loadHistoryRows(organizationId, window, [appId]), window, timeZone);
}
