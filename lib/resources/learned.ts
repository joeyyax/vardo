// Learned memory defaults: an app with no limit of its own gets one sized from its own daily p99, within its tier's range.

import type { DailyPeak } from "@/lib/autotune/decide";
import { zonedDateKey, UTC } from "@/lib/time-zone";

const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60_000;
const STEP_MB = 64;
/** Samples are read in one-minute buckets. */
export const BUCKET_MS = 60_000;

/** Days of recorded p99 before a learned default applies. */
export const LEARN_MIN_DAYS = 7;
/** Only days this recent count. */
export const LEARN_WINDOW_DAYS = 14;
/** Learned limit over the window's highest daily p99. */
export const LEARN_HEADROOM = 1.3;
/** One-minute samples a day needs before its p99 counts: half the day. */
export const LEARN_MIN_SAMPLES = 720;

export type LearnedDefault = {
  mb: number;
  days: number;
  p99Bytes: number;
  peakBytes: number;
  /** Set when the tier's range held the value. */
  bound: "floor" | "ceiling" | null;
  floorMb: number;
  ceilingMb: number;
  /** "Learned from 9 days: p99 380 MB, peak 410 MB". */
  reason: string;
};

/** Progress toward a learned default, for the Resources tab. */
export type LearnedStatus = { learned: LearnedDefault | null; days: number; needDays: number };

const ceilStep = (mb: number) => Math.max(STEP_MB, Math.ceil(mb / STEP_MB) * STEP_MB);

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1).replace(/\.0$/, "")} GB` : `${Math.round(mb)} MB`;
}

const formatBytesMb = (bytes: number) => formatMb(bytes / MIB);

/** Floor and ceiling for a tier default: half to twice it. */
export function learnedRange(tierDefaultMb: number): { floorMb: number; ceilingMb: number } {
  return { floorMb: ceilStep(tierDefaultMb / 2), ceilingMb: tierDefaultMb * 2 };
}

/** Days in the window with a recorded p99, oldest first. */
export function learningDays(days: DailyPeak[], now: number): DailyPeak[] {
  const from = zonedDateKey(new Date(now - LEARN_WINDOW_DAYS * DAY), UTC);
  return days.filter((d) => d.day >= from && typeof d.p99 === "number" && d.p99 > 0);
}

/** The learned limit in MB, or null until there are enough days. */
export function learnedDefault(days: DailyPeak[], tierDefaultMb: number, now: number): LearnedDefault | null {
  const usable = learningDays(days, now);
  if (usable.length < LEARN_MIN_DAYS || !(tierDefaultMb > 0)) return null;

  const p99Bytes = Math.max(...usable.map((d) => d.p99!));
  const peakBytes = Math.max(...usable.map((d) => Math.max(d.bytes, d.p99!)));
  const wanted = ceilStep((p99Bytes / MIB) * LEARN_HEADROOM);
  const { floorMb, ceilingMb } = learnedRange(tierDefaultMb);
  const mb = Math.min(ceilingMb, Math.max(floorMb, wanted));
  const bound = wanted < floorMb ? "floor" : wanted > ceilingMb ? "ceiling" : null;

  let reason = `Learned from ${usable.length} days: p99 ${formatBytesMb(p99Bytes)}, peak ${formatBytesMb(peakBytes)}`;
  if (bound === "floor") reason += `; held at the tier's floor of ${formatMb(floorMb)}`;
  if (bound === "ceiling") reason += `; held at the tier's ceiling of ${formatMb(ceilingMb)}`;
  return { mb, days: usable.length, p99Bytes, peakBytes, bound, floorMb, ceilingMb, reason };
}

export function learnedStatus(days: DailyPeak[], tierDefaultMb: number, now: number): LearnedStatus {
  return {
    learned: learnedDefault(days, tierDefaultMb, now),
    days: learningDays(days, now).length,
    needDays: LEARN_MIN_DAYS,
  };
}

/** The 99th percentile by nearest rank. Null for no values. */
export function percentile99(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)];
}

/** The UTC day before `now`: its key and bounds. */
export function previousUtcDay(now: number): { day: string; from: number; to: number } {
  const to = Math.floor(now / DAY) * DAY;
  return { day: zonedDateKey(new Date(to - DAY), UTC), from: to - DAY, to };
}

/** p99 and peak over a day's one-minute samples. Null when too little of the day was sampled. */
export function dayUsage(points: [number, number][][]): { p99: number; peak: number } | null {
  const minutes = new Set<number>();
  const values: number[] = [];
  for (const series of points) {
    for (const [ts, value] of series) {
      minutes.add(Math.floor(ts / BUCKET_MS));
      values.push(value);
    }
  }
  if (minutes.size < LEARN_MIN_SAMPLES) return null;
  const p99 = percentile99(values);
  return p99 && p99 > 0 ? { p99, peak: values.reduce((a, b) => Math.max(a, b), 0) } : null;
}
