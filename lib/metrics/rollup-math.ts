// Hourly per-app rollup math. Pure: series and checks in, rows out.

import { appResourceScope, seriesInScope, type ResourceScope, type ScopedApp } from "./resource-scope";
import type { LabeledSeries } from "./resource-samples";

export const HOUR_MS = 60 * 60_000;
/** Sub-hour bucket the store aggregates into. Divides an hour. */
export const SLOT_MS = 5 * 60_000;
/** Counter samples further apart than this can't be placed in one hour; their delta is dropped. */
export const MAX_COUNTER_GAP_MS = 15 * 60_000;

/** Upper edges in ms of the response-time histogram, plus one overflow bucket. Changing them breaks stored rows. */
export const RESPONSE_BUCKETS_MS = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000] as const;

export const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;
export const ceilHour = (ms: number) => Math.ceil(ms / HOUR_MS) * HOUR_MS;

/** Store reads per run, each one TS.MRANGE aggregated into SLOT_MS buckets. */
export const SLOT_READS = {
  cpu: { metric: "cpu", aggregation: "avg" },
  samples: { metric: "cpu", aggregation: "count" },
  memory: { metric: "memory", aggregation: "avg" },
  memoryLimit: { metric: "memoryLimit", aggregation: "max" },
  networkRx: { metric: "networkRx", aggregation: "last" },
  networkTx: { metric: "networkTx", aggregation: "last" },
} as const;

export type SlotRead = keyof typeof SLOT_READS;
export type SlotSeries = Record<SlotRead, LabeledSeries[]>;

/** `defaultEnvironment` is the environment whose containers count; a stack child takes its parent's. */
export type RollupApp = ScopedApp & { organizationId: string; defaultEnvironment?: string | null };

/** Name a deploy without an environment runs under. */
const FALLBACK_ENVIRONMENT = "production";
const SLOTS = new Set(["blue", "green", "shared"]);

/** `env` from `env-<slot>-…`. Null for the legacy unscoped `<slot>-…` layout. */
function slotEnvironment(rest: string): string | null {
  const env = /^(.+?)-(?:blue|green|shared)-/.exec(rest)?.[1];
  return env && !SLOTS.has(env) ? env : null;
}

/** Environment a series ran under: its label, else a suffixed compose project, else its container name. Null when none is named. */
export function seriesEnvironment(series: LabeledSeries, appName: string): string | null {
  if (series.environment) return series.environment;
  const prefix = `${appName}-`;
  // Unlabeled shared services store under their compose project, `<app>-<env>-shared`.
  if (series.project.startsWith(prefix)) return slotEnvironment(`${series.project.slice(prefix.length)}-`);
  const name = series.containerName ?? "";
  return name.startsWith(prefix) ? slotEnvironment(name.slice(prefix.length)) : null;
}

/** Whether a series belongs to the app's default environment. Series naming none count. */
function isProductionSeries(series: LabeledSeries, appName: string, defaultEnvironment?: string | null): boolean {
  const env = seriesEnvironment(series, appName);
  return env === null || env === FALLBACK_ENVIRONMENT || env === defaultEnvironment;
}

export type RollupCheck = {
  appId: string;
  checkedAt: Date;
  reachable: boolean;
  responseTimeMs: number | null;
};

export type HourRow = {
  appId: string;
  organizationId: string;
  hour: Date;
  metricMinutes: number;
  sampleCount: number;
  cpuAvg: number | null;
  cpuPeak: number | null;
  memoryAvg: number | null;
  memoryPeak: number | null;
  memoryLimit: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  checksTotal: number;
  checksUp: number;
  responseCount: number;
  responseMsSum: number;
  responseHistogram: number[];
};

export function emptyHistogram(): number[] {
  return new Array(RESPONSE_BUCKETS_MS.length + 1).fill(0);
}

export function histogramBucket(ms: number): number {
  const i = RESPONSE_BUCKETS_MS.findIndex((edge) => ms <= edge);
  return i === -1 ? RESPONSE_BUCKETS_MS.length : i;
}

/** Percentile from a histogram, interpolated inside its bucket. The overflow bucket reads as its lower edge. */
export function histogramPercentile(histogram: number[], p: number): number | null {
  const total = histogram.reduce((s, n) => s + n, 0);
  if (total === 0) return null;
  const rank = p * total;
  let below = 0;
  for (let i = 0; i < histogram.length; i++) {
    const n = histogram[i] ?? 0;
    if (n > 0 && below + n >= rank) {
      const lower = i === 0 ? 0 : RESPONSE_BUCKETS_MS[i - 1]!;
      if (i >= RESPONSE_BUCKETS_MS.length) return lower;
      const upper = RESPONSE_BUCKETS_MS[i]!;
      return Math.round(lower + ((upper - lower) * Math.max(0, rank - below)) / n);
    }
    below += n;
  }
  return RESPONSE_BUCKETS_MS[RESPONSE_BUCKETS_MS.length - 1]!;
}

export function addHistograms(into: number[], from: number[]): number[] {
  for (let i = 0; i < from.length; i++) into[i] = (into[i] ?? 0) + (from[i] ?? 0);
  return into;
}

/**
 * Which series each app owns: its default environment's only.
 * A parent with stack children keeps only services no child claims.
 */
function scopeFilters(apps: RollupApp[]): Map<string, (all: LabeledSeries[]) => LabeledSeries[]> {
  const knownAppNames = new Set(apps.filter((a) => !a.parentAppId).map((a) => a.name));
  const childServices = new Map<string, Set<string>>();
  for (const app of apps) {
    if (!app.parentAppId || !app.composeService) continue;
    const set = childServices.get(app.parentAppId) ?? new Set<string>();
    set.add(app.composeService);
    childServices.set(app.parentAppId, set);
  }

  const filters = new Map<string, (all: LabeledSeries[]) => LabeledSeries[]>();
  for (const app of apps) {
    // A child without a service would take the whole stack and count it twice.
    if (app.parentAppId && !app.composeService) continue;
    const scope: ResourceScope = appResourceScope(app, knownAppNames);
    const appName = scope.appNames[0]!;
    const claimed = childServices.get(app.id);
    filters.set(app.id, (all) => {
      const own = seriesInScope(all, scope).filter((s) => isProductionSeries(s, appName, app.defaultEnvironment));
      return claimed ? own.filter((s) => s.service === null || !claimed.has(s.service)) : own;
    });
  }
  return filters;
}

type ContainerSlots = Map<string, Map<number, number>>;

function byContainer(series: LabeledSeries[]): ContainerSlots {
  return new Map(series.map((s) => [s.container || s.key, new Map(s.points)]));
}

/** Counter bytes per hour from per-slot last readings. A reset counts the new reading. */
export function counterBytesByHour(series: LabeledSeries[], fromMs: number, toMs: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of series) {
    for (let i = 1; i < s.points.length; i++) {
      const [prevTs, prev] = s.points[i - 1]!;
      const [ts, value] = s.points[i]!;
      if (ts < fromMs || ts >= toMs || ts - prevTs > MAX_COUNTER_GAP_MS) continue;
      const bytes = value >= prev ? value - prev : value;
      const hour = floorHour(ts);
      out.set(hour, (out.get(hour) ?? 0) + bytes);
    }
  }
  return out;
}

type MetricHour = Pick<HourRow, "metricMinutes" | "sampleCount" | "cpuAvg" | "cpuPeak" | "memoryAvg" | "memoryPeak" | "memoryLimit">;

/** CPU and memory for one app over one hour, from per-slot container readings. */
function metricHour(hour: number, cpu: ContainerSlots, samples: ContainerSlots, memory: ContainerSlots, limit: ContainerSlots): MetricHour | null {
  let covered = 0;
  let sampleCount = 0;
  let cpuTotal = 0;
  let cpuPeak = 0;
  let memTotal = 0;
  let memPeak = 0;
  let lastLimit: number | null = null;

  for (let slot = hour; slot < hour + HOUR_MS; slot += SLOT_MS) {
    let cpuSum = 0;
    let memSum = 0;
    let limitSum: number | null = 0;
    let present = 0;
    for (const [container, slots] of cpu) {
      const value = slots.get(slot);
      if (value === undefined) continue;
      present++;
      cpuSum += value;
      sampleCount += samples.get(container)?.get(slot) ?? 0;
      memSum += memory.get(container)?.get(slot) ?? 0;
      const l = limit.get(container)?.get(slot);
      limitSum = limitSum === null || !l ? null : limitSum + l;
    }
    if (present === 0) continue;
    covered++;
    cpuTotal += cpuSum;
    cpuPeak = Math.max(cpuPeak, cpuSum);
    memTotal += memSum;
    memPeak = Math.max(memPeak, memSum);
    lastLimit = limitSum;
  }

  if (covered === 0) return null;
  return {
    metricMinutes: (covered * SLOT_MS) / 60_000,
    sampleCount,
    cpuAvg: round2(cpuTotal / covered),
    cpuPeak: round2(cpuPeak),
    memoryAvg: Math.round(memTotal / covered),
    memoryPeak: Math.round(memPeak),
    memoryLimit: lastLimit,
  };
}

type CheckHour = Pick<HourRow, "checksTotal" | "checksUp" | "responseCount" | "responseMsSum" | "responseHistogram">;

function checkHours(checks: RollupCheck[], fromMs: number, toMs: number): Map<string, Map<number, CheckHour>> {
  const out = new Map<string, Map<number, CheckHour>>();
  for (const c of checks) {
    const at = c.checkedAt.getTime();
    if (at < fromMs || at >= toMs) continue;
    const hour = floorHour(at);
    const perApp = out.get(c.appId) ?? new Map<number, CheckHour>();
    out.set(c.appId, perApp);
    const h = perApp.get(hour) ?? { checksTotal: 0, checksUp: 0, responseCount: 0, responseMsSum: 0, responseHistogram: emptyHistogram() };
    perApp.set(hour, h);
    h.checksTotal++;
    if (!c.reachable) continue;
    h.checksUp++;
    if (c.responseTimeMs === null) continue;
    h.responseCount++;
    h.responseMsSum += c.responseTimeMs;
    h.responseHistogram[histogramBucket(c.responseTimeMs)]!++;
  }
  return out;
}

/** One row per app per hour in [fromMs, toMs) with any samples or checks. */
export function buildHourRows(input: {
  apps: RollupApp[];
  series: SlotSeries;
  checks: RollupCheck[];
  fromMs: number;
  toMs: number;
}): HourRow[] {
  const { apps, series, checks, fromMs, toMs } = input;
  const filters = scopeFilters(apps);
  const checksByApp = checkHours(checks, fromMs, toMs);
  const rows: HourRow[] = [];

  for (const app of apps) {
    const own = filters.get(app.id);
    const cpu = own ? byContainer(own(series.cpu)) : new Map();
    const samples = own ? byContainer(own(series.samples)) : new Map();
    const memory = own ? byContainer(own(series.memory)) : new Map();
    const limit = own ? byContainer(own(series.memoryLimit)) : new Map();
    const rx = own ? counterBytesByHour(own(series.networkRx), fromMs, toMs) : new Map<number, number>();
    const tx = own ? counterBytesByHour(own(series.networkTx), fromMs, toMs) : new Map<number, number>();
    const appChecks = checksByApp.get(app.id);

    for (let hour = fromMs; hour < toMs; hour += HOUR_MS) {
      const m = cpu.size > 0 ? metricHour(hour, cpu, samples, memory, limit) : null;
      const c = appChecks?.get(hour);
      if (!m && !c) continue;
      rows.push({
        appId: app.id,
        organizationId: app.organizationId,
        hour: new Date(hour),
        metricMinutes: m?.metricMinutes ?? 0,
        sampleCount: m?.sampleCount ?? 0,
        cpuAvg: m?.cpuAvg ?? null,
        cpuPeak: m?.cpuPeak ?? null,
        memoryAvg: m?.memoryAvg ?? null,
        memoryPeak: m?.memoryPeak ?? null,
        memoryLimit: m?.memoryLimit ?? null,
        networkRxBytes: m || rx.has(hour) ? Math.round(rx.get(hour) ?? 0) : null,
        networkTxBytes: m || tx.has(hour) ? Math.round(tx.get(hour) ?? 0) : null,
        checksTotal: c?.checksTotal ?? 0,
        checksUp: c?.checksUp ?? 0,
        responseCount: c?.responseCount ?? 0,
        responseMsSum: c?.responseMsSum ?? 0,
        responseHistogram: c?.responseHistogram ?? emptyHistogram(),
      });
    }
  }
  return rows;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
