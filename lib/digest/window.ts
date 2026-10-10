// Digest cadences and the complete days, in the org's time zone, they cover.

import { addZonedDays, startOfZonedDay, UTC, zonedDateKey, zonedParts, zonedTimeToUtc } from "@/lib/time-zone";

export const DIGEST_CADENCES = ["daily", "weekly"] as const;
export type DigestCadence = (typeof DIGEST_CADENCES)[number];

export type DigestSchedule = {
  enabled: boolean;
  cadence: DigestCadence;
  /** 0 = Sunday. Weekly only. */
  dayOfWeek: number;
  /** Hour in the org's time zone. */
  hourOfDay: number;
};

export const DEFAULT_DIGEST: DigestSchedule = { enabled: true, cadence: "weekly", dayOfWeek: 1, hourOfDay: 8 };

export type DigestWindow = {
  cadence: DigestCadence;
  /** Stable for the whole window; each window sends once. */
  windowKey: string;
  since: Date;
  until: Date;
  /** Zone the window's days are cut in. */
  timeZone: string;
};

const DAY_MS = 86_400_000;

export function isDigestCadence(value: unknown): value is DigestCadence {
  return typeof value === "string" && (DIGEST_CADENCES as readonly string[]).includes(value);
}

/** A stored row over the defaults. No row is the defaults. */
export function scheduleFor(
  row: { enabled: boolean; cadence: string; dayOfWeek: number; hourOfDay: number } | null | undefined,
): DigestSchedule {
  if (!row) return DEFAULT_DIGEST;
  return {
    enabled: row.enabled,
    cadence: isDigestCadence(row.cadence) ? row.cadence : DEFAULT_DIGEST.cadence,
    dayOfWeek: row.dayOfWeek,
    hourOfDay: row.hourOfDay,
  };
}

/** The window that closed at today's midnight in `tz`: yesterday, or the seven days before today. Never partial. */
export function digestWindow(cadence: DigestCadence, now: Date, tz: string = UTC): DigestWindow {
  const until = startOfZonedDay(now, tz);
  const since = addZonedDays(until, cadence === "daily" ? -1 : -7, tz);
  return { cadence, windowKey: `${cadence}:${zonedDateKey(since, tz)}`, since, until, timeZone: tz };
}

/** Due during the org's hour in `tz`, and for weekly only on its day. An hour DST skips runs right after the jump. */
export function isDigestDue(schedule: DigestSchedule, now: Date, tz: string = UTC): boolean {
  if (!schedule.enabled) return false;
  const today = zonedParts(now, tz);
  if (schedule.cadence === "weekly" && today.weekday !== schedule.dayOfWeek) return false;
  const start = zonedTimeToUtc({ ...today, hour: schedule.hourOfDay, minute: 0 }, tz).getTime();
  return now.getTime() >= start && now.getTime() < start + 3_600_000;
}

/** Buckets across a window, oldest first. Day buckets follow the zone's midnights, so a DST day is 23 or 25 hours. */
export function bucketStarts(
  window: Pick<DigestWindow, "since" | "until"> & { timeZone?: string },
  bucketMs: number,
): number[] {
  const out: number[] = [];
  if (bucketMs === DAY_MS) {
    const tz = window.timeZone ?? UTC;
    for (let d = window.since; d < window.until; d = addZonedDays(d, 1, tz)) out.push(d.getTime());
    return out;
  }
  for (let t = window.since.getTime(); t < window.until.getTime(); t += bucketMs) out.push(t);
  return out;
}

/** A daily digest charts hours; a weekly one, days. */
export function bucketMsFor(cadence: DigestCadence): number {
  return cadence === "daily" ? 60 * 60_000 : DAY_MS;
}
