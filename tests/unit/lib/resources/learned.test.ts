import { describe, it, expect } from "vitest";
import { addDailyPeak, limitOrigin, type DailyPeak } from "@/lib/autotune/decide";
import {
  LEARN_MIN_SAMPLES,
  dayUsage,
  learnedDefault,
  learnedRange,
  learnedStatus,
  percentile99,
  previousUtcDay,
} from "@/lib/resources/learned";
import { describeMemory } from "@/lib/resources/profile";

const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 9, 20, 12);

const dayKey = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);

/** Days ending yesterday, each with a p99 and a peak in MiB. */
function history(count: number, p99Mb: number, peakMb = p99Mb, startAgo = 1): DailyPeak[] {
  return Array.from({ length: count }, (_, i) => ({ day: dayKey(startAgo + count - 1 - i), bytes: peakMb * MIB, p99: p99Mb * MIB }));
}

describe("learnedDefault", () => {
  it("waits for seven days of p99", () => {
    expect(learnedDefault(history(6, 400), 1024, NOW)).toBeNull();
    expect(learnedDefault(history(7, 400), 1024, NOW)).not.toBeNull();
  });

  it("sizes p99 × 1.3, rounded up to 64 MB", () => {
    // 400 × 1.3 = 520 → 576.
    expect(learnedDefault(history(9, 400, 410), 1024, NOW)).toMatchObject({
      mb: 576,
      days: 9,
      bound: null,
      reason: "Learned from 9 days: p99 400 MB, peak 410 MB",
    });
  });

  it("uses the highest daily p99 in the window", () => {
    const days = history(8, 300);
    days[3] = { ...days[3], p99: 700 * MIB, bytes: 800 * MIB };
    expect(learnedDefault(days, 1024, NOW)).toMatchObject({ mb: 960, peakBytes: 800 * MIB });
  });

  it("holds at half the tier default", () => {
    const learned = learnedDefault(history(7, 50), 1024, NOW)!;
    expect(learned).toMatchObject({ mb: 512, bound: "floor" });
    expect(learned.reason).toMatch(/held at the tier's floor of 512 MB$/);
  });

  it("holds at twice the tier default", () => {
    const learned = learnedDefault(history(7, 3000), 1024, NOW)!;
    expect(learned).toMatchObject({ mb: 2048, bound: "ceiling" });
    expect(learned.reason).toMatch(/held at the tier's ceiling of 2 GB$/);
  });

  it("sits exactly on the bounds without calling them out", () => {
    // 393.8 × 1.3 = 512 → floor; 1575 × 1.3 = 2047.5 → 2048 ceiling.
    expect(learnedDefault(history(7, 393.8), 1024, NOW)).toMatchObject({ mb: 512, bound: null });
    expect(learnedDefault(history(7, 1575), 1024, NOW)).toMatchObject({ mb: 2048, bound: null });
  });

  it("ignores days outside the 14-day window and days without a p99", () => {
    const old = history(7, 400, 400, 15);
    expect(learnedDefault(old, 1024, NOW)).toBeNull();
    const peaksOnly = history(7, 400).map(({ day, bytes }) => ({ day, bytes }));
    expect(learnedDefault(peaksOnly, 1024, NOW)).toBeNull();
  });

  it("follows the tier default it's given", () => {
    expect(learnedRange(960)).toEqual({ floorMb: 512, ceilingMb: 1920 });
    expect(learnedDefault(history(7, 100), 4096, NOW)).toMatchObject({ mb: 2048, bound: "floor" });
  });

  it("reports progress before it applies", () => {
    expect(learnedStatus(history(3, 400), 1024, NOW)).toEqual({ learned: null, days: 3, needDays: 7 });
  });
});

describe("daily usage", () => {
  it("takes the 99th percentile by nearest rank", () => {
    expect(percentile99([])).toBeNull();
    expect(percentile99([5])).toBe(5);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile99(hundred)).toBe(99);
    expect(percentile99([...hundred, 101])).toBe(100);
  });

  it("needs half a day of minutes", () => {
    const minutes = (n: number, value = 100): [number, number][] => Array.from({ length: n }, (_, i) => [i * 60_000, value]);
    expect(dayUsage([minutes(LEARN_MIN_SAMPLES - 1)])).toBeNull();
    expect(dayUsage([minutes(LEARN_MIN_SAMPLES)])).toEqual({ p99: 100, peak: 100 });
  });

  it("pools every container and keeps the peak", () => {
    const a: [number, number][] = Array.from({ length: 1440 }, (_, i) => [i * 60_000, 100]);
    const b: [number, number][] = [[0, 900]];
    expect(dayUsage([a, b])).toEqual({ p99: 100, peak: 900 });
  });

  it("records the UTC day before now", () => {
    expect(previousUtcDay(Date.UTC(2026, 9, 20, 0, 5))).toEqual({
      day: "2026-10-19",
      from: Date.UTC(2026, 9, 19),
      to: Date.UTC(2026, 9, 20),
    });
  });

  it("keeps a day's p99 when auto-adjust adds a peak", () => {
    let peaks = addDailyPeak([], "2026-10-19", 500, 400);
    peaks = addDailyPeak(peaks, "2026-10-19", 600);
    expect(peaks).toEqual([{ day: "2026-10-19", bytes: 600, p99: 400 }]);
    expect(addDailyPeak(peaks, "2026-10-20", 100)).toEqual([
      { day: "2026-10-19", bytes: 600, p99: 400 },
      { day: "2026-10-20", bytes: 100 },
    ]);
  });
});

describe("explicit limits win", () => {
  it("counts a container at the learned default as a default", () => {
    const base = { appLimitMb: null, appliedMb: null, tierDefaultMb: 1024 };
    expect(limitOrigin({ ...base, containerLimitBytes: 576 * MIB, learnedMb: 576 })).toBe("default");
    expect(limitOrigin({ ...base, containerLimitBytes: 576 * MIB })).toBe("compose");
    expect(limitOrigin({ ...base, containerLimitBytes: 1024 * MIB, learnedMb: 576 })).toBe("default");
    expect(limitOrigin({ ...base, appLimitMb: 768, containerLimitBytes: 768 * MIB, learnedMb: 768 })).toBe("app");
  });

  const describe_ = (over: Partial<Parameters<typeof describeMemory>[0]>) =>
    describeMemory({
      appProfile: "fixed",
      orgProfile: "fixed",
      appLimitMb: null,
      reservationMb: null,
      tierDefaultMb: 1024,
      tier: "standard",
      learned: { mb: 576, reason: "Learned from 9 days: p99 400 MB, peak 410 MB" },
      containerLimitBytes: null,
      autotune: null,
      formatDate: (d) => d.toISOString(),
      ...over,
    });

  it("explains a learned limit", () => {
    expect(describe_({})).toMatchObject({ limitMb: 576, why: "Learned from 9 days: p99 400 MB, peak 410 MB." });
    expect(describe_({ containerLimitBytes: 576 * MIB }).why).toMatch(/^Learned from 9 days/);
  });

  it("says a limit set in Vardo wins", () => {
    expect(describe_({ appLimitMb: 2048 })).toMatchObject({ limitMb: 2048, why: "Set in Vardo." });
  });

  it("still names a compose limit", () => {
    expect(describe_({ containerLimitBytes: 3000 * MIB })).toMatchObject({ limitMb: 3000, why: "Set in compose." });
  });

  it("names the tier default while the container still runs it", () => {
    expect(describe_({ containerLimitBytes: 1024 * MIB }).why).toBe("The standard tier default.");
  });
});
