// Digest frequencies and the complete days, in the org's time zone, each window covers.

import { addZonedDays, startOfZonedDay, UTC, zonedDateKey, zonedParts, zonedTimeToUtc } from "@/lib/time-zone";

export const DIGEST_FREQUENCIES = ["weekly", "monthly", "off"] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];
export type DigestCadence = Exclude<DigestFrequency, "off">;

/** A person with no preference gets the weekly digest. */
export const DEFAULT_FREQUENCY: DigestFrequency = "weekly";

export type DigestSchedule = {
  enabled: boolean;
  /** 0 = Sunday. Weekly digests; monthly ones go out on the 1st. */
  dayOfWeek: number;
  /** Hour in the org's time zone. */
  hourOfDay: number;
};

export const DEFAULT_DIGEST: DigestSchedule = { enabled: true, dayOfWeek: 1, hourOfDay: 8 };

export type DigestWindow = {
  cadence: DigestCadence;
  /** Stable for the whole window; each window sends once per person. */
  windowKey: string;
  since: Date;
  until: Date;
  /** Zone the window's days are cut in. */
  timeZone: string;
};

export function isDigestFrequency(value: unknown): value is DigestFrequency {
  return typeof value === "string" && (DIGEST_FREQUENCIES as readonly string[]).includes(value);
}

/** A stored frequency, or the default for no row or a value it doesn't know. */
export function frequencyFor(row: { frequency: string } | null | undefined): DigestFrequency {
  return row && isDigestFrequency(row.frequency) ? row.frequency : DEFAULT_FREQUENCY;
}

/** A stored row over the defaults. No row is the defaults. */
export function scheduleFor(row: { enabled: boolean; dayOfWeek: number; hourOfDay: number } | null | undefined): DigestSchedule {
  if (!row) return DEFAULT_DIGEST;
  return { enabled: row.enabled, dayOfWeek: row.dayOfWeek, hourOfDay: row.hourOfDay };
}

/** Midnight on the 1st of the month holding `date`, `months` later. */
function startOfZonedMonth(date: Date, tz: string, months = 0): Date {
  const p = zonedParts(date, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1 + months, 1));
  return zonedTimeToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: 1, hour: 0, minute: 0 }, tz);
}

/** The window that closed at today's midnight in `tz`: the seven days before today, or last calendar month. */
export function digestWindow(cadence: DigestCadence, now: Date, tz: string = UTC): DigestWindow {
  if (cadence === "monthly") {
    const until = startOfZonedMonth(now, tz);
    const since = startOfZonedMonth(now, tz, -1);
    return { cadence, windowKey: `monthly:${zonedDateKey(since, tz).slice(0, 7)}`, since, until, timeZone: tz };
  }
  const until = startOfZonedDay(now, tz);
  const since = addZonedDays(until, -7, tz);
  return { cadence, windowKey: `weekly:${zonedDateKey(since, tz)}`, since, until, timeZone: tz };
}

/** Due during the org's hour in `tz`: weekly on its day, monthly on the 1st. An hour DST skips runs right after the jump. */
export function isDigestDue(schedule: DigestSchedule, cadence: DigestCadence, now: Date, tz: string = UTC): boolean {
  if (!schedule.enabled) return false;
  const today = zonedParts(now, tz);
  if (cadence === "weekly" && today.weekday !== schedule.dayOfWeek) return false;
  if (cadence === "monthly" && today.day !== 1) return false;
  const start = zonedTimeToUtc({ ...today, hour: schedule.hourOfDay, minute: 0 }, tz).getTime();
  return now.getTime() >= start && now.getTime() < start + 3_600_000;
}

/** Local day starts across a window, oldest first. A DST day is 23 or 25 hours. */
export function dayStarts(window: Pick<DigestWindow, "since" | "until"> & { timeZone?: string }): number[] {
  const tz = window.timeZone ?? UTC;
  const out: number[] = [];
  for (let d = window.since; d < window.until; d = addZonedDays(d, 1, tz)) out.push(d.getTime());
  return out;
}
