/** Cron expression utilities backed by croner. */

import { Cron } from "croner";
import { offsetAt, UTC } from "@/lib/time-zone";

/**
 * Whether the schedule fires at `now` in `tz`, or in the server's zone without one. False for invalid expressions.
 * Across DST, a time the jump skips runs right after it, and a fixed-hour time that repeats runs once.
 */
export function shouldRunNow(schedule: string, now: Date, tz?: string | null): boolean {
  const expr = schedule.trim();
  if (!expr) return false;
  try {
    // Ticks land mid-minute and croner matches only at :00; zero the seconds or jobs never fire.
    const t = Math.floor(now.getTime() / 60_000) * 60_000;
    const job = new Cron(expr, tz ? { timezone: tz } : {});
    if (!tz || tz === UTC) return job.match(new Date(t));

    if (job.match(new Date(t))) {
      const fellBack = offsetAt(t - 2 * 3_600_000, tz) - offsetAt(t, tz);
      if (fellBack <= 0 || !hasFixedHour(expr)) return true;
      // The same wall time already ran before the clocks went back.
      return offsetAt(t - fellBack, tz) !== offsetAt(t - 2 * 3_600_000, tz);
    }

    const jumped = offsetAt(t, tz) - offsetAt(t - 60_000, tz);
    if (jumped <= 0) return false;
    const wall = new Cron(expr, { timezone: UTC });
    const wallNow = t + offsetAt(t, tz);
    for (let skipped = 60_000; skipped <= jumped; skipped += 60_000) {
      if (wall.match(new Date(wallNow - skipped))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Whether the hour field names hours rather than every hour. */
function hasFixedHour(expr: string): boolean {
  const fields = expr.split(/\s+/);
  const hour = fields.length >= 6 ? fields[2] : fields[1];
  return hour !== undefined && !hour.startsWith("*");
}

/** Whether croner accepts the expression. */
export function isValidSchedule(schedule: string): boolean {
  if (!schedule.trim()) return false;
  try {
    new Cron(schedule.trim());
    return true;
  } catch {
    return false;
  }
}

/** Whether two dates fall within the same calendar minute. */

export function isSameMinute(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}
