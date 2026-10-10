// An app's normal: robust stats per hour of day, split weekday and weekend, over a rolling window.

export type Sample = { at: number; value: number };

export type BucketStats = {
  median: number;
  /** Median absolute deviation. */
  mad: number;
  p95: number;
  count: number;
};

export type Baseline = {
  /** Oldest sample in the window. */
  learningSince: number;
  /** 0-23 weekday hours, 24-47 weekend hours. */
  buckets: (BucketStats | null)[];
  /** Every sample pooled, for a bucket with too few of its own. */
  overall: BucketStats | null;
};

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export const BASELINE_WINDOW_MS = 14 * DAY;
export const WARMUP_MS = 3 * DAY;
/** One sample every five minutes. */
export const SAMPLE_MS = 5 * 60_000;
/** An hour of samples before a bucket stands on its own. */
export const MIN_BUCKET_SAMPLES = 12;
export const BUCKETS = 48;

/** Scales MAD to a standard deviation for normal data. */
const MAD_SCALE = 1.4826;

/** Offset from UTC in ms at `at`. */
export type ZoneOffset = (at: number) => number;

export const utcOffset: ZoneOffset = () => 0;

/** Offset for an IANA zone, cached per hour. */
export function zoneOffset(timeZone: string): ZoneOffset {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return utcOffset;
  }
  const cache = new Map<number, number>();
  return (at) => {
    const hour = Math.floor(at / HOUR);
    const hit = cache.get(hour);
    if (hit !== undefined) return hit;
    const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
    const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
    const offset = local - Math.floor(at / 60_000) * 60_000;
    cache.set(hour, offset);
    return offset;
  };
}

export function bucketIndex(at: number, offset: ZoneOffset = utcOffset): number {
  const local = new Date(at + offset(at));
  const day = local.getUTCDay();
  const weekend = day === 0 || day === 6;
  return (weekend ? 24 : 0) + local.getUTCHours();
}

/** Linear-interpolated quantile of sorted values. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function bucketStats(values: number[]): BucketStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  return { median, mad: quantile(deviations, 0.5), p95: quantile(sorted, 0.95), count: sorted.length };
}

/** Baseline from the samples inside the window ending at `now`. Null with none. */
export function computeBaseline(samples: Sample[], now: number, offset: ZoneOffset = utcOffset): Baseline | null {
  const since = now - BASELINE_WINDOW_MS;
  const inWindow = samples.filter((s) => s.at > since && s.at <= now && Number.isFinite(s.value));
  if (inWindow.length === 0) return null;

  const byBucket: number[][] = Array.from({ length: BUCKETS }, () => []);
  let learningSince = Infinity;
  for (const s of inWindow) {
    byBucket[bucketIndex(s.at, offset)].push(s.value);
    learningSince = Math.min(learningSince, s.at);
  }
  return {
    learningSince,
    buckets: byBucket.map((values) => (values.length > 0 ? bucketStats(values) : null)),
    overall: bucketStats(inWindow.map((s) => s.value)),
  };
}

export function isWarm(baseline: Baseline | null | undefined, now: number): baseline is Baseline {
  return !!baseline && now - baseline.learningSince >= WARMUP_MS;
}

/** The stats for the hour `at` falls in, or the pooled stats when that hour is thin. */
export function statsAt(baseline: Baseline, at: number, offset: ZoneOffset = utcOffset): BucketStats | null {
  const own = baseline.buckets[bucketIndex(at, offset)];
  return own && own.count >= MIN_BUCKET_SAMPLES ? own : baseline.overall;
}

/** Top of the normal range: the larger of p95 and median plus three robust deviations. */
export function highMark(stats: BucketStats): number {
  return Math.max(stats.p95, stats.median + 3 * MAD_SCALE * stats.mad);
}
