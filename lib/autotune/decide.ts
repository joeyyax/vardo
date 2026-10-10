// Auto memory profile decisions. Pure: callers read the app, host and state, then apply what comes back.

import type { ResourceProfile } from "@/lib/db/schema/enums";

const MIB = 1024 * 1024;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** New limit over observed peak. */
export const HEADROOM = 1.5;
/** At most one raise per app in this window. */
export const RAISE_INTERVAL_MS = 6 * HOUR;
/** Raises without a calm day in between before auto-adjust stops. */
export const MAX_RAISE_STREAK = 3;
/** A raise counts as settled after this long without another. */
export const SETTLE_MS = DAY;
/** Days of low peaks before a limit comes down. */
export const LOWER_AFTER_DAYS = 14;
/** Peaks under this share of the limit count as well below it. */
export const LOWER_BELOW_SHARE = 0.4;
/** Default share of host RAM one app's limit may take. */
export const DEFAULT_HOST_SHARE = 0.5;
/** Host memory kept free after a raise: the larger of this share of RAM and 1 GiB. */
export const HOST_RESERVE_SHARE = 0.1;
const MIN_HOST_RESERVE = 1024 * MIB;

/** Peak × 1.5 in MB, rounded up to a step that grows with the size. */
export function suggestedLimitMb(peakBytes: number): number {
  const mb = (peakBytes / MIB) * HEADROOM;
  const step = mb < 1024 ? 128 : mb < 4096 ? 256 : mb < 16384 ? 512 : 1024;
  return Math.max(step, Math.ceil(mb / step) * step);
}

export type LimitOrigin = "app" | "autotune" | "compose" | "default" | "none" | "unknown";

/** Where a container's limit came from, from the app row and what Docker reports. */
export function limitOrigin(input: {
  appLimitMb: number | null;
  appliedMb: number | null;
  containerLimitBytes: number | null;
  tierDefaultMb: number;
}): LimitOrigin {
  const { appLimitMb, appliedMb, containerLimitBytes, tierDefaultMb } = input;
  if (appLimitMb !== null) {
    if (appLimitMb > 0 && appliedMb === appLimitMb) return "autotune";
    return appLimitMb > 0 ? "app" : "none";
  }
  if (containerLimitBytes === null) return "unknown";
  if (containerLimitBytes === 0) return "none";
  return Math.abs(containerLimitBytes - tierDefaultMb * MIB) <= MIB ? "default" : "compose";
}

/** Whether the auto profile may change this app's limit. An inherited auto skips limits someone set. */
export function autotuneEligible(input: { appProfile: ResourceProfile | null; orgProfile: ResourceProfile; origin: LimitOrigin }): boolean {
  if (input.origin === "none" || input.origin === "unknown") return false;
  if (input.appProfile !== null) return input.appProfile === "auto";
  return input.orgProfile === "auto" && (input.origin === "default" || input.origin === "autotune");
}

export type AutotuneState = {
  lastRaisedAt: Date | null;
  lastChangedAt: Date | null;
  raiseStreak: number;
  haltedAt: Date | null;
};

export type HostMemory = {
  totalBytes: number | null;
  availableBytes: number | null;
};

export type RaiseInput = {
  trigger: "oom" | "pressure";
  currentMb: number;
  /** Highest observed use in bytes; a limit kill passes at least the limit. */
  peakBytes: number;
  /** Org or instance ceiling in MB, the lower of the two. */
  ceilingMb: number | null;
  /** Share of host RAM the limit may take. */
  hostShare: number;
  host: HostMemory;
  state: AutotuneState;
  now: number;
};

export type RaiseDecision =
  | { action: "raise"; fromMb: number; toMb: number; capped: boolean }
  | { action: "halt"; raises: number }
  | { action: "hold"; reason: "halted" | "rate-limited" | "at-ceiling" | "host-tight" | "no-gain" };

/** Host memory kept free whatever a raise wants. */
export function hostReserveBytes(totalBytes: number): number {
  return Math.max(MIN_HOST_RESERVE, totalBytes * HOST_RESERVE_SHARE);
}

/** Whether to raise the limit, and to what. */
export function decideRaise(input: RaiseInput): RaiseDecision {
  const { state, now, currentMb, host } = input;
  if (state.haltedAt) return { action: "hold", reason: "halted" };
  if (state.lastRaisedAt && now - state.lastRaisedAt.getTime() < RAISE_INTERVAL_MS) {
    return { action: "hold", reason: "rate-limited" };
  }
  if (state.raiseStreak >= MAX_RAISE_STREAK) return { action: "halt", raises: state.raiseStreak };

  const wanted = suggestedLimitMb(Math.max(input.peakBytes, input.trigger === "oom" ? currentMb * MIB : 0));
  const caps = [input.ceilingMb ?? Infinity];
  if (host.totalBytes) caps.push(Math.floor((host.totalBytes * input.hostShare) / MIB));
  const cap = Math.min(...caps);
  const toMb = Math.min(wanted, cap);
  if (toMb <= currentMb) return { action: "hold", reason: wanted > currentMb ? "at-ceiling" : "no-gain" };

  // Unreadable host memory refuses: a raise is only safe when there's room for it.
  if (!host.totalBytes || host.availableBytes === null) return { action: "hold", reason: "host-tight" };
  const growth = (toMb - currentMb) * MIB;
  if (host.availableBytes - growth < hostReserveBytes(host.totalBytes)) return { action: "hold", reason: "host-tight" };

  return { action: "raise", fromMb: currentMb, toMb, capped: toMb < wanted };
}

export type DailyPeak = { day: string; bytes: number };

/** Keeps the higher reading per day and the last `LOWER_AFTER_DAYS + 1` days. */
export function addDailyPeak(peaks: DailyPeak[], day: string, bytes: number): DailyPeak[] {
  const byDay = new Map(peaks.map((p) => [p.day, p.bytes]));
  byDay.set(day, Math.max(byDay.get(day) ?? 0, bytes));
  return [...byDay]
    .map(([d, b]) => ({ day: d, bytes: b }))
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-(LOWER_AFTER_DAYS + 1));
}

export type LowerInput = {
  currentMb: number;
  /** Tier default in MB; a lowered limit never goes under it. */
  floorMb: number;
  peaks: DailyPeak[];
  /** Day keys for the last `LOWER_AFTER_DAYS` full days, oldest first. */
  days: string[];
  state: AutotuneState;
  now: number;
};

export type LowerDecision = { action: "lower"; fromMb: number; toMb: number } | { action: "hold" };

/** Whether two weeks of low peaks justify a lower limit. */
export function decideLower(input: LowerInput): LowerDecision {
  const { state, now, currentMb } = input;
  if (state.haltedAt) return { action: "hold" };
  if (state.lastChangedAt && now - state.lastChangedAt.getTime() < LOWER_AFTER_DAYS * DAY) return { action: "hold" };

  const byDay = new Map(input.peaks.map((p) => [p.day, p.bytes]));
  const readings = input.days.map((d) => byDay.get(d));
  if (readings.length < LOWER_AFTER_DAYS || readings.some((b) => b === undefined)) return { action: "hold" };

  const peak = Math.max(...(readings as number[]));
  if (peak >= currentMb * MIB * LOWER_BELOW_SHARE) return { action: "hold" };

  const toMb = Math.max(input.floorMb, suggestedLimitMb(peak));
  return toMb < currentMb ? { action: "lower", fromMb: currentMb, toMb } : { action: "hold" };
}

/** Whether the last raise has held long enough to reset the streak. */
export function streakSettled(state: AutotuneState, now: number, lastTroubleAt: number | null): boolean {
  if (state.raiseStreak === 0 || !state.lastRaisedAt) return false;
  const since = Math.max(state.lastRaisedAt.getTime(), lastTroubleAt ?? 0);
  return now - since >= SETTLE_MS;
}
