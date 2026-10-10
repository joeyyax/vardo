import { describe, expect, it } from "vitest";
import {
  addDailyPeak,
  autotuneEligible,
  decideLower,
  decideRaise,
  limitOrigin,
  MAX_RAISE_STREAK,
  RAISE_INTERVAL_MS,
  streakSettled,
  suggestedLimitMb,
  type AutotuneState,
  type RaiseInput,
} from "@/lib/autotune/decide";
import { ceilingFor, instanceAutotuneLimits, previousDays } from "@/lib/autotune/run";
import { memoryUpdateBody } from "@/lib/autotune/apply";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const now = Date.parse("2026-10-10T12:00:00Z");

const fresh: AutotuneState = { lastRaisedAt: null, lastChangedAt: null, raiseStreak: 0, haltedAt: null };

function raiseInput(over: Partial<RaiseInput> = {}): RaiseInput {
  return {
    trigger: "oom",
    currentMb: 2048,
    peakBytes: 2 * GIB,
    ceilingMb: null,
    hostShare: 0.5,
    host: { totalBytes: 32 * GIB, availableBytes: 16 * GIB },
    state: fresh,
    now,
    ...over,
  };
}

describe("suggestedLimitMb", () => {
  it("adds half again and rounds up to a step that grows with size", () => {
    expect(suggestedLimitMb(2 * GIB)).toBe(3072);
    expect(suggestedLimitMb(300 * MIB)).toBe(512);
    expect(suggestedLimitMb(1000 * MIB)).toBe(1536);
    expect(suggestedLimitMb(5 * GIB)).toBe(7680);
    expect(suggestedLimitMb(12 * GIB)).toBe(18432);
  });

  it("never suggests less than one step", () => {
    expect(suggestedLimitMb(10 * MIB)).toBe(128);
  });
});

describe("limitOrigin", () => {
  const base = { appLimitMb: null, appliedMb: null, containerLimitBytes: 2048 * MIB, tierDefaultMb: 2048 };

  it("tells the tier default from a compose limit by the container's limit", () => {
    expect(limitOrigin(base)).toBe("default");
    expect(limitOrigin({ ...base, containerLimitBytes: 1024 * MIB })).toBe("compose");
    expect(limitOrigin({ ...base, containerLimitBytes: 0 })).toBe("none");
    expect(limitOrigin({ ...base, containerLimitBytes: null })).toBe("unknown");
  });

  it("knows its own limit from one a person set", () => {
    expect(limitOrigin({ ...base, appLimitMb: 3072, appliedMb: 3072 })).toBe("autotune");
    expect(limitOrigin({ ...base, appLimitMb: 4096, appliedMb: 3072 })).toBe("app");
  });
});

describe("autotuneEligible", () => {
  it("follows an org default of Auto only for limits nobody set", () => {
    expect(autotuneEligible({ appProfile: null, orgProfile: "auto", origin: "default" })).toBe(true);
    expect(autotuneEligible({ appProfile: null, orgProfile: "auto", origin: "autotune" })).toBe(true);
    expect(autotuneEligible({ appProfile: null, orgProfile: "auto", origin: "compose" })).toBe(false);
    expect(autotuneEligible({ appProfile: null, orgProfile: "auto", origin: "app" })).toBe(false);
    expect(autotuneEligible({ appProfile: null, orgProfile: "fixed", origin: "default" })).toBe(false);
  });

  it("lets an app choose Auto over its own limit, or Fixed and Burstable to stay put", () => {
    expect(autotuneEligible({ appProfile: "auto", orgProfile: "fixed", origin: "compose" })).toBe(true);
    expect(autotuneEligible({ appProfile: "fixed", orgProfile: "auto", origin: "default" })).toBe(false);
    expect(autotuneEligible({ appProfile: "burstable", orgProfile: "auto", origin: "default" })).toBe(false);
    expect(autotuneEligible({ appProfile: "auto", orgProfile: "auto", origin: "none" })).toBe(false);
  });
});

describe("decideRaise", () => {
  it("raises an OOM kill to peak × 1.5, counting the limit as the peak", () => {
    expect(decideRaise(raiseInput({ peakBytes: 1 * GIB }))).toEqual({ action: "raise", fromMb: 2048, toMb: 3072, capped: false });
  });

  it("raises sustained pressure from the observed peak", () => {
    expect(decideRaise(raiseInput({ trigger: "pressure", peakBytes: 1900 * MIB }))).toMatchObject({ action: "raise", toMb: 3072 });
  });

  it("caps at the ceiling and at the host share", () => {
    expect(decideRaise(raiseInput({ ceilingMb: 2560 }))).toEqual({ action: "raise", fromMb: 2048, toMb: 2560, capped: true });
    expect(decideRaise(raiseInput({ host: { totalBytes: 5 * GIB, availableBytes: 3 * GIB } }))).toMatchObject({ toMb: 2560, capped: true });
  });

  it("holds when the limit is already at the ceiling", () => {
    expect(decideRaise(raiseInput({ ceilingMb: 2048 }))).toEqual({ action: "hold", reason: "at-ceiling" });
  });

  it("refuses when the host is tight", () => {
    expect(decideRaise(raiseInput({ host: { totalBytes: 32 * GIB, availableBytes: 3 * GIB } }))).toEqual({ action: "hold", reason: "host-tight" });
    expect(decideRaise(raiseInput({ host: { totalBytes: null, availableBytes: null } }))).toEqual({ action: "hold", reason: "host-tight" });
  });

  it("raises at most once per 6 hours", () => {
    const recent = { ...fresh, raiseStreak: 1, lastRaisedAt: new Date(now - RAISE_INTERVAL_MS + HOUR) };
    expect(decideRaise(raiseInput({ state: recent }))).toEqual({ action: "hold", reason: "rate-limited" });
    const older = { ...recent, lastRaisedAt: new Date(now - RAISE_INTERVAL_MS) };
    expect(decideRaise(raiseInput({ state: older })).action).toBe("raise");
  });

  it("stops after too many raises without settling, and stays stopped", () => {
    const streak = { ...fresh, raiseStreak: MAX_RAISE_STREAK, lastRaisedAt: new Date(now - DAY / 2) };
    expect(decideRaise(raiseInput({ state: streak }))).toEqual({ action: "halt", raises: MAX_RAISE_STREAK });
    expect(decideRaise(raiseInput({ state: { ...streak, haltedAt: new Date(now) } }))).toEqual({ action: "hold", reason: "halted" });
  });
});

describe("streakSettled", () => {
  const raised = { ...fresh, raiseStreak: 2, lastRaisedAt: new Date(now - 2 * DAY) };

  it("settles a day after the last raise with no trouble since", () => {
    expect(streakSettled(raised, now, null)).toBe(true);
    expect(streakSettled(raised, now, now - HOUR)).toBe(false);
    expect(streakSettled(fresh, now, null)).toBe(false);
  });
});

describe("decideLower", () => {
  const days = previousDays(now);
  const lowPeaks = days.map((day) => ({ day, bytes: 500 * MIB }));
  const raised = { ...fresh, lastChangedAt: new Date(now - 15 * DAY) };

  it("lowers after 14 days of peaks well under the limit, never below the tier floor", () => {
    expect(decideLower({ currentMb: 4096, floorMb: 512, peaks: lowPeaks, days, state: raised, now })).toEqual({ action: "lower", fromMb: 4096, toMb: 768 });
    expect(decideLower({ currentMb: 4096, floorMb: 2048, peaks: lowPeaks, days, state: raised, now })).toEqual({ action: "lower", fromMb: 4096, toMb: 2048 });
  });

  it("holds with a missing day, a high day or a recent change", () => {
    expect(decideLower({ currentMb: 4096, floorMb: 512, peaks: lowPeaks.slice(1), days, state: raised, now }).action).toBe("hold");
    const spiky = lowPeaks.map((p, i) => (i === 3 ? { ...p, bytes: 2 * GIB } : p));
    expect(decideLower({ currentMb: 4096, floorMb: 512, peaks: spiky, days, state: raised, now }).action).toBe("hold");
    expect(decideLower({ currentMb: 4096, floorMb: 512, peaks: lowPeaks, days, state: { ...raised, lastChangedAt: new Date(now - 3 * DAY) }, now }).action).toBe("hold");
  });

  it("never raises", () => {
    expect(decideLower({ currentMb: 1024, floorMb: 1024, peaks: lowPeaks, days, state: raised, now }).action).toBe("hold");
  });
});

describe("addDailyPeak", () => {
  it("keeps the day's highest reading and a bounded history", () => {
    let peaks = addDailyPeak([], "2026-10-01", 100);
    peaks = addDailyPeak(peaks, "2026-10-01", 50);
    expect(peaks).toEqual([{ day: "2026-10-01", bytes: 100 }]);
    for (let d = 2; d <= 20; d++) peaks = addDailyPeak(peaks, `2026-10-${String(d).padStart(2, "0")}`, d);
    expect(peaks).toHaveLength(15);
    expect(peaks.at(-1)).toEqual({ day: "2026-10-20", bytes: 20 });
  });
});

describe("limits", () => {
  it("reads the instance ceiling and host share from the environment", () => {
    expect(instanceAutotuneLimits({})).toEqual({ ceilingMb: null, hostShare: 0.5 });
    expect(instanceAutotuneLimits({ VARDO_AUTOTUNE_MAX_MB: "8192", VARDO_AUTOTUNE_HOST_SHARE: "0.25" })).toEqual({ ceilingMb: 8192, hostShare: 0.25 });
    expect(instanceAutotuneLimits({ VARDO_AUTOTUNE_MAX_MB: "10", VARDO_AUTOTUNE_HOST_SHARE: "2" })).toEqual({ ceilingMb: null, hostShare: 0.5 });
  });

  it("takes the lowest of the app, org and instance ceilings", () => {
    expect(ceilingFor(null, 4096, 8192)).toBe(4096);
    expect(ceilingFor(3072, 4096, 8192)).toBe(3072);
    expect(ceilingFor(null, null, 8192)).toBe(8192);
    expect(ceilingFor(null, null, null)).toBeNull();
  });
});

describe("memoryUpdateBody", () => {
  it("moves the swap allowance up with the limit", () => {
    expect(memoryUpdateBody(3 * GIB, { memory: 2 * GIB, swap: 4 * GIB })).toEqual({ Memory: 3 * GIB, MemorySwap: 5 * GIB });
  });

  it("leaves unlimited or unset swap alone", () => {
    expect(memoryUpdateBody(3 * GIB, { memory: 2 * GIB, swap: -1 })).toEqual({ Memory: 3 * GIB });
    expect(memoryUpdateBody(3 * GIB, { memory: 2 * GIB, swap: 0 })).toEqual({ Memory: 3 * GIB });
  });
});
