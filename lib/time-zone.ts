// IANA time zones: validation, wall-clock math and formatting. No I/O; settings live in ./time-zone-settings.

export const UTC = "UTC";

/** Whether Intl knows the zone. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The server's zone: `TZ`, then the runtime's, then UTC. */
export function serverTimeZone(): string {
  const env = process.env.TZ;
  if (env && env !== ":/etc/localtime" && isValidTimeZone(env)) return env;
  const runtime = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(runtime) ? runtime : UTC;
}

/** Every zone the runtime knows, for pickers. */
export function listTimeZones(): string[] {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return zones.includes(UTC) ? zones : [UTC, ...zones];
}

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    partsFormatters.set(tz, fmt);
  }
  return fmt;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Wall-clock fields of `date` in `tz`. Weekday 0 is Sunday. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    weekday: WEEKDAYS.indexOf(out.weekday),
  };
}

/** `YYYY-MM-DD` of `date` in `tz`. */
export function zonedDateKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Milliseconds `tz` is ahead of UTC at `ms`. */
export function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(new Date(ms), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

/**
 * The instant a wall-clock time happens in `tz`. A time a DST jump skips lands after the jump
 * (02:30 becomes 03:30); a time that happens twice takes the first.
 */
export function zonedTimeToUtc(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  tz: string,
): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const before = offsetAt(guess - 86_400_000, tz);
  const after = offsetAt(guess + 86_400_000, tz);
  const matches = [...new Set([before, after])]
    .map((o) => guess - o)
    .filter((t) => offsetAt(t, tz) === guess - t)
    .sort((a, b) => a - b);
  return new Date(matches[0] ?? guess - before);
}

/** Midnight that starts the zoned day holding `date`. */
export function startOfZonedDay(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, tz);
}

/** Midnight of the zoned day `days` after the one starting at `dayStart`. */
export function addZonedDays(dayStart: Date, days: number, tz: string): Date {
  const p = zonedParts(dayStart, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedTimeToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0 }, tz);
}

/** Short zone name at `date`: "UTC", "PDT", "GMT+2". */
export function zoneAbbreviation(date: Date, tz: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? tz;
}

/** "14:05" in `tz`. */
export function formatClock(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "02:00–02:04 PDT". */
export function formatClockRange(start: Date, end: Date, tz: string): string {
  return `${formatClock(start, tz)}–${formatClock(end, tz)} ${zoneAbbreviation(start, tz)}`;
}

/** "Oct 9, 14:05 PDT". */
export function formatDayTime(date: Date, tz: string): string {
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
  return `${day}, ${formatClock(date, tz)} ${zoneAbbreviation(date, tz)}`;
}

/** "2026-10-09 14:05 PDT". */
export function formatStamp(date: Date, tz: string): string {
  return `${zonedDateKey(date, tz)} ${formatClock(date, tz)} ${zoneAbbreviation(date, tz)}`;
}
