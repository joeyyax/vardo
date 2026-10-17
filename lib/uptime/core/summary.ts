// Rolls raw results into hourly and daily buckets of minutes up, down and unknown. Missing data is unknown, never up.

import { isUnknownResult, type Bucket, type CheckResult, type VantagePoint } from "./types";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Percent up of the minutes known, to two decimals. Null when none are known. */
export function uptimePct(up: number, down: number): number | null {
  const known = up + down;
  return known === 0 ? null : Math.round((up / known) * 10_000) / 100;
}

function makeBucket(start: number, up: number, down: number, unknown: number, latencyMs: number | null): Bucket {
  return { start, minutesUp: up, minutesDown: down, minutesUnknown: unknown, uptimePct: uptimePct(up, down), medianLatencyMs: latencyMs };
}

/** A failure counts once a neighbor from the same vantage point failed too; a lone one is a blip. */
function confirmed(sorted: CheckResult[]): boolean[] {
  return sorted.map((r, i) => !r.ok && (sorted[i - 1]?.ok === false || sorted[i + 1]?.ok === false));
}

/**
 * Up or down per minute index for one vantage point. A result covers its own interval
 * (at least one minute) or until the next result, whichever is shorter.
 */
function vantageMinutes(results: CheckResult[], intervalSec: number, fromMin: number, toMin: number): Map<number, boolean> {
  const sorted = [...results].sort((a, b) => a.at - b.at);
  const down = confirmed(sorted);
  const cover = Math.max(1, Math.ceil(intervalSec / 60));
  const out = new Map<number, boolean>();
  sorted.forEach((r, i) => {
    const start = Math.floor(r.at / MINUTE_MS);
    const next = sorted[i + 1] ? Math.floor(sorted[i + 1].at / MINUTE_MS) : Infinity;
    const end = Math.min(start + cover, Math.max(next, start + 1));
    for (let m = Math.max(start, fromMin); m < Math.min(end, toMin); m++) out.set(m, !down[i]);
  });
  return out;
}

/**
 * Buckets of `bucketMs` covering [from, to), counting only minutes that have elapsed. A minute is down when most of the vantage points with data
 * for it are failing; external ones decide when any has data, else the local one.
 */
export function summarize(args: {
  results: CheckResult[];
  vantages: VantagePoint[];
  intervalSec: number;
  from: number;
  to: number;
  bucketMs: number;
}): Bucket[] {
  const { bucketMs } = args;
  const first = Math.floor(args.from / bucketMs) * bucketMs;
  const fromMin = first / MINUTE_MS;
  const toMin = Math.ceil(args.to / MINUTE_MS);
  const perBucket = bucketMs / MINUTE_MS;

  const kinds = new Map(args.vantages.map((v) => [v.id, v.kind]));
  const byVantage = new Map<string, CheckResult[]>();
  for (const r of args.results) {
    if (!kinds.has(r.vantageId) || isUnknownResult(r)) continue;
    const list = byVantage.get(r.vantageId);
    if (list) list.push(r);
    else byVantage.set(r.vantageId, [r]);
  }
  const minutes = [...byVantage].map(([id, list]) => ({
    kind: kinds.get(id)!,
    map: vantageMinutes(list, args.intervalSec, fromMin, toMin),
  }));

  const latencies = new Map<number, number[]>();
  for (const r of args.results) {
    if (!r.ok || r.at < first || r.at >= args.to) continue;
    const key = Math.floor(r.at / bucketMs) * bucketMs;
    const list = latencies.get(key);
    if (list) list.push(r.latencyMs);
    else latencies.set(key, [r.latencyMs]);
  }

  const buckets: Bucket[] = [];
  for (let start = first; start < args.to; start += bucketMs) {
    let up = 0;
    let down = 0;
    let unknown = 0;
    const base = start / MINUTE_MS;
    for (let m = base; m < Math.min(base + perBucket, toMin); m++) {
      const present = minutes.filter((v) => v.map.has(m));
      const external = present.filter((v) => v.kind === "external");
      const deciding = external.length > 0 ? external : present.filter((v) => v.kind === "local");
      if (deciding.length === 0) unknown++;
      else if (deciding.filter((v) => v.map.get(m) === false).length * 2 > deciding.length) down++;
      else up++;
    }
    buckets.push(makeBucket(start, up, down, unknown, median(latencies.get(start) ?? [])));
  }
  return buckets;
}

/** Folds buckets into one, such as hours into a day. The latency is the median of the buckets' medians. */
export function combine(buckets: Bucket[], start: number): Bucket {
  let up = 0;
  let down = 0;
  let unknown = 0;
  const latencies: number[] = [];
  for (const b of buckets) {
    up += b.minutesUp;
    down += b.minutesDown;
    unknown += b.minutesUnknown;
    if (b.medianLatencyMs !== null) latencies.push(b.medianLatencyMs);
  }
  return makeBucket(start, up, down, unknown, median(latencies));
}

/** Uptime over a run of buckets, to two decimals. Null when no minute in it is known. */
export function rangeUptime(buckets: Bucket[]): number | null {
  const merged = combine(buckets, 0);
  return merged.uptimePct;
}

/** The unknown-filled day buckets for a range, so a gap shows as no data. */
export function fillDays(buckets: Bucket[], fromDay: number, days: number): Bucket[] {
  const byStart = new Map(buckets.map((b) => [b.start, b]));
  return Array.from({ length: days }, (_, i) => {
    const start = fromDay + i * DAY_MS;
    return byStart.get(start) ?? makeBucket(start, 0, 0, DAY_MS / MINUTE_MS, null);
  });
}

export type Outage = { start: number; end: number | null };

/** Runs of down minutes, joined across a one-minute gap. `end` is null while the latest minute is still down. */
export function findOutages(args: {
  results: CheckResult[];
  vantages: VantagePoint[];
  intervalSec: number;
  from: number;
  to: number;
}): Outage[] {
  const minutes = summarize({ ...args, bucketMs: MINUTE_MS });
  const out: Outage[] = [];
  let open: Outage | null = null;
  let lastDown = 0;
  for (const m of minutes) {
    if (m.minutesDown > 0) {
      if (open && m.start - lastDown > 2 * MINUTE_MS) {
        open.end = lastDown + MINUTE_MS;
        out.push(open);
        open = null;
      }
      open ??= { start: m.start, end: null };
      lastDown = m.start;
    }
  }
  if (open) {
    const ongoing = lastDown + MINUTE_MS >= minutes[minutes.length - 1].start;
    open.end = ongoing ? null : lastDown + MINUTE_MS;
    out.push(open);
  }
  return out;
}
