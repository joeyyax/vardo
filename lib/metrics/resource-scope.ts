// ---------------------------------------------------------------------------
// Which stored series belong to one app or one project, and how they combine.
//
// Pure over LabeledSeries so the double-counting rules can be tested without a
// Redis. The rule that matters: every container in a decomposed stack stores
// under the parent's `project` label, so a project total built from top-level
// apps already contains the children. Adding child apps to that list counts
// them twice.
// ---------------------------------------------------------------------------

import { composeProjectApp } from "@/lib/docker/slot-partition";
import type { LabeledSeries } from "./resource-samples";
import type { SeriesPoint } from "./resource-types";

/** How old the newest sample can be and still describe the subject now. */
export const FRESH_WINDOW_MS = 5 * 60 * 1000;

/** An app row as far as resource scoping is concerned. */
export type ScopedApp = {
  id: string;
  name: string;
  parentAppId?: string | null;
  composeService?: string | null;
  parentApp?: { name: string } | null;
};

export type ResourceScope = {
  /** Top-level app names whose `project` label this subject owns. */
  appNames: string[];
  /** `service` label narrowing to one stack child. Null takes every service. */
  service: string | null;
  /** Every top-level app name in the instance, used to guard the slot fold. */
  knownAppNames?: ReadonlySet<string>;
};

/**
 * Series scope for one app. A stack child reads under its parent's name and
 * narrows by compose service; everything else reads under its own name.
 */
export function appResourceScope(
  app: ScopedApp,
  knownAppNames?: ReadonlySet<string>,
): ResourceScope {
  if (!app.parentAppId) {
    return { appNames: [app.name], service: null, knownAppNames };
  }
  return {
    appNames: [app.parentApp?.name ?? app.name],
    service: app.composeService ?? null,
    knownAppNames,
  };
}

/**
 * Series scope for a Vardo project. Takes top-level apps only — a child's
 * containers are already inside its parent's `project` label, so including
 * children here is the double count a project total must not have.
 */
export function projectResourceScope(
  projectApps: ScopedApp[],
  knownAppNames?: ReadonlySet<string>,
): ResourceScope {
  const topLevel = projectApps.filter((a) => !a.parentAppId);
  return { appNames: topLevel.map((a) => a.name), service: null, knownAppNames };
}

/**
 * Whether a series belongs to the scope.
 *
 * A shared service keeps its compose project name (`adguard-production-blue`)
 * instead of the app's, so the slot suffix is folded off before comparing. The
 * fold is skipped when the raw name is itself a known app, which is what stops
 * one app's series being read as another's.
 */
export function inScope(series: LabeledSeries, scope: ResourceScope): boolean {
  if (scope.service !== null && series.service !== scope.service) return false;
  if (scope.appNames.includes(series.project)) return true;
  if (scope.knownAppNames?.has(series.project)) return false;
  return scope.appNames.includes(composeProjectApp(series.project));
}

/** Series in scope, one per container — a container can only be counted once. */
export function seriesInScope(
  all: LabeledSeries[] | undefined,
  scope: ResourceScope,
): LabeledSeries[] {
  if (!all) return [];
  const byContainer = new Map<string, LabeledSeries>();
  for (const series of all) {
    if (!inScope(series, scope)) continue;
    // Series stored per project rather than per container carry no container
    // label; keying those on the series name keeps them from collapsing.
    const key = series.container || series.key;
    const existing = byContainer.get(key);
    // Same container under two project labels: keep whichever reported last.
    if (existing && lastTimestamp(existing) >= lastTimestamp(series)) continue;
    byContainer.set(key, series);
  }
  return [...byContainer.values()];
}

function lastTimestamp(series: LabeledSeries): number {
  return series.points.length > 0 ? series.points[series.points.length - 1][0] : -Infinity;
}

export type Combine = "sum" | "max" | "avg";

export type Aggregate = {
  /** Combined current value, null when nothing in scope is fresh. */
  value: number | null;
  /** Newest sample time behind `value`. */
  at: number | null;
  /** Distinct containers that contributed. */
  containers: number;
  /** Combined series, oldest first. */
  series: SeriesPoint[];
};

const EMPTY: Aggregate = { value: null, at: null, containers: 0, series: [] };

/** Combine every in-scope container's samples into one reading. */
export function aggregate(
  all: LabeledSeries[] | undefined,
  scope: ResourceScope,
  combine: Combine,
  now: number,
): Aggregate {
  const scoped = seriesInScope(all, scope);
  if (scoped.length === 0) return EMPTY;

  const cutoff = now - FRESH_WINDOW_MS;
  const latest: number[] = [];
  let at: number | null = null;

  for (const series of scoped) {
    const last = series.points[series.points.length - 1];
    if (!last || last[0] < cutoff) continue;
    latest.push(last[1]);
    at = at === null ? last[0] : Math.max(at, last[0]);
  }

  return {
    value: latest.length > 0 ? round(fold(latest, combine)) : null,
    at,
    containers: latest.length,
    series: foldSeries(scoped, combine),
  };
}

/** Per-bucket combination across containers. */
function foldSeries(scoped: LabeledSeries[], combine: Combine): SeriesPoint[] {
  const byTimestamp = new Map<number, number[]>();
  for (const series of scoped) {
    for (const [ts, value] of series.points) {
      const bucket = byTimestamp.get(ts);
      if (bucket) bucket.push(value);
      else byTimestamp.set(ts, [value]);
    }
  }
  return [...byTimestamp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, values]) => [ts, round(fold(values, combine))] as SeriesPoint);
}

function fold(values: number[], combine: Combine): number {
  if (combine === "max") return Math.max(...values);
  const total = values.reduce((sum, v) => sum + v, 0);
  return combine === "avg" ? total / values.length : total;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Bytes per second across the scope, from the last two samples of each
 * container's cumulative counter.
 *
 * A counter that fell restarted, and the sample after a restart carries the
 * whole counter again — both are dropped rather than reported as a spike.
 * Null when no container yielded a usable pair.
 */
export function counterRate(
  all: LabeledSeries[] | undefined,
  scope: ResourceScope,
  now: number,
): { value: number | null; at: number | null } {
  const scoped = seriesInScope(all, scope);
  const cutoff = now - FRESH_WINDOW_MS;

  let total = 0;
  let contributed = 0;
  let at: number | null = null;

  for (const series of scoped) {
    const points = series.points;
    if (points.length < 2) continue;
    const [prevTs, prevValue] = points[points.length - 2];
    const [lastTs, lastValue] = points[points.length - 1];
    if (lastTs < cutoff) continue;

    const seconds = (lastTs - prevTs) / 1000;
    const delta = lastValue - prevValue;
    if (seconds <= 0 || delta < 0) continue;

    total += delta / seconds;
    contributed++;
    at = at === null ? lastTs : Math.max(at, lastTs);
  }

  return { value: contributed > 0 ? round(total) : null, at };
}

/** Per-bucket rate series for a cumulative counter, gaps left as null. */
export function counterRateSeries(
  all: LabeledSeries[] | undefined,
  scope: ResourceScope,
): SeriesPoint[] {
  const scoped = seriesInScope(all, scope);
  const byTimestamp = new Map<number, number>();

  for (const series of scoped) {
    for (let i = 1; i < series.points.length; i++) {
      const [prevTs, prevValue] = series.points[i - 1];
      const [ts, value] = series.points[i];
      const seconds = (ts - prevTs) / 1000;
      const delta = value - prevValue;
      if (seconds <= 0 || delta < 0) continue;
      byTimestamp.set(ts, (byTimestamp.get(ts) ?? 0) + delta / seconds);
    }
  }

  return [...byTimestamp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, value]) => [ts, round(value)] as SeriesPoint);
}

/**
 * Whether every in-scope sample is zero.
 *
 * A cumulative counter pinned at zero for a whole window was not counting.
 * cAdvisor runs with `--disable_metrics=diskIO`, and the collector stored that
 * as a literal 0 until it was taught not to, so a week of zeros outlives the
 * fix and would otherwise render as "wrote nothing".
 */
export function allZero(all: LabeledSeries[] | undefined, scope: ResourceScope): boolean {
  const scoped = seriesInScope(all, scope);
  if (scoped.length === 0) return false;
  return scoped.every((s) => s.points.every(([, value]) => value === 0));
}

/**
 * How many in-scope containers report a non-zero memory limit, against how many
 * report at all. `enforced` needs every one of them capped.
 */
export function limitCoverage(
  all: LabeledSeries[] | undefined,
  scope: ResourceScope,
  now: number,
): { limited: number; total: number; sum: number } {
  const scoped = seriesInScope(all, scope);
  const cutoff = now - FRESH_WINDOW_MS;
  let limited = 0;
  let total = 0;
  let sum = 0;

  for (const series of scoped) {
    const last = series.points[series.points.length - 1];
    if (!last || last[0] < cutoff) continue;
    total++;
    if (last[1] > 0) {
      limited++;
      sum += last[1];
    }
  }

  return { limited, total, sum };
}
