import { describe, expect, it } from "vitest";
import {
  BASELINE_WINDOW_MS,
  MIN_BUCKET_SAMPLES,
  SAMPLE_MS,
  WARMUP_MS,
  bucketIndex,
  bucketStats,
  computeBaseline,
  highMark,
  isWarm,
  quantile,
  statsAt,
  zoneOffset,
  type Sample,
} from "@/lib/anomaly/baseline";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// A Wednesday, 12:00 UTC.
const now = Date.UTC(2026, 9, 7, 12, 0);

/** One sample every five minutes over `days`, ending at `now`. */
function history(days: number, value: (at: number) => number): Sample[] {
  const out: Sample[] = [];
  for (let at = now - days * DAY + SAMPLE_MS; at <= now; at += SAMPLE_MS) out.push({ at, value: value(at) });
  return out;
}

describe("robust stats", () => {
  it("interpolates quantiles", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([0, 10], 0.95)).toBeCloseTo(9.5);
    expect(quantile([], 0.5)).toBe(0);
  });

  it("keeps the median and MAD steady through outliers", () => {
    const stats = bucketStats([10, 11, 9, 10, 12, 10, 500]);
    expect(stats?.median).toBe(10);
    expect(stats?.mad).toBe(1);
    expect(stats?.count).toBe(7);
  });

  it("puts the high mark at p95 or three robust deviations, whichever is higher", () => {
    expect(highMark({ median: 10, mad: 1, p95: 20, count: 100 })).toBe(20);
    expect(highMark({ median: 10, mad: 2, p95: 12, count: 100 })).toBeCloseTo(10 + 3 * 1.4826 * 2);
  });
});

describe("buckets", () => {
  it("splits weekday and weekend hours", () => {
    expect(bucketIndex(Date.UTC(2026, 9, 7, 3))).toBe(3);
    expect(bucketIndex(Date.UTC(2026, 9, 10, 3))).toBe(27);
    expect(bucketIndex(Date.UTC(2026, 9, 11, 23))).toBe(47);
  });

  it("reads the hour in the org's zone", () => {
    const offset = zoneOffset("America/New_York");
    // 03:00 UTC Saturday is 23:00 Friday in New York.
    expect(bucketIndex(Date.UTC(2026, 9, 10, 3), offset)).toBe(23);
    expect(offset(Date.UTC(2026, 0, 15))).toBe(-5 * HOUR);
  });

  it("falls back to UTC for an unknown zone", () => {
    expect(zoneOffset("Not/AZone")(now)).toBe(0);
  });
});

describe("computeBaseline", () => {
  it("learns a typical value per hour", () => {
    const baseline = computeBaseline(history(7, (at) => (new Date(at).getUTCHours() === 12 ? 50 : 5)), now)!;
    expect(statsAt(baseline, now)?.median).toBe(50);
    expect(statsAt(baseline, now - 3 * HOUR)?.median).toBe(5);
  });

  it("ignores samples outside the rolling window", () => {
    const old = [{ at: now - BASELINE_WINDOW_MS - HOUR, value: 1000 }];
    const baseline = computeBaseline([...old, ...history(4, () => 2)], now)!;
    expect(baseline.overall?.median).toBe(2);
    expect(baseline.learningSince).toBeGreaterThan(now - BASELINE_WINDOW_MS);
  });

  it("uses the pooled stats when an hour is thin", () => {
    const samples = history(4, () => 3).filter((s) => new Date(s.at).getUTCHours() !== 12 || s.at > now - MIN_BUCKET_SAMPLES * SAMPLE_MS);
    const baseline = computeBaseline(samples, now)!;
    expect(baseline.buckets[12]!.count).toBeLessThan(MIN_BUCKET_SAMPLES);
    expect(statsAt(baseline, now)).toBe(baseline.overall);
  });

  it("is null with nothing to learn from", () => {
    expect(computeBaseline([], now)).toBeNull();
  });
});

describe("warm-up", () => {
  it("needs three days of history", () => {
    expect(isWarm(computeBaseline(history(2, () => 1), now), now)).toBe(false);
    expect(isWarm(computeBaseline(history(3, () => 1), now), now + SAMPLE_MS)).toBe(true);
    expect(isWarm(null, now)).toBe(false);
    expect(WARMUP_MS).toBe(3 * DAY);
  });
});
