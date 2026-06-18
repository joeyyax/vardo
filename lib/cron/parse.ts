/**
 * Cron expression utilities — backed by croner.
 *
 * Supports the full cron expression syntax including:
 *   - Standard five-part expressions: minute hour day month weekday
 *   - Named shorthands: @daily, @hourly, @weekly, @monthly
 *   - Step values: *\/N, N-M/N
 *   - Ranges: N-M
 *   - Lists: N,M
 *   - Timezone-aware matching via croner options
 */

import { Cron } from "croner";

/**
 * Returns true if the given cron schedule should fire at the given moment.
 * Returns false for invalid expressions rather than throwing.
 */
export function shouldRunNow(schedule: string, now: Date): boolean {
  if (!schedule.trim()) return false;
  try {
    const job = new Cron(schedule.trim());
    // Match at minute granularity. The schedulers tick on a 60s interval at an
    // arbitrary sub-minute offset (whatever second the process booted on),
    // while croner's match() is second-precise — a 5-field cron matches only at
    // :00. Without truncating, a job fires only if a tick happens to land on
    // second 0 of its minute, which it essentially never does, so jobs silently
    // never run. Zero the seconds so any tick within the scheduled minute
    // matches; the schedulers' per-minute locks prevent double-firing.
    const atMinute = new Date(now);
    atMinute.setSeconds(0, 0);
    return job.match(atMinute);
  } catch {
    return false;
  }
}

/**
 * Returns true if two dates fall within the same calendar minute.
 * Used by the backup scheduler to avoid double-firing.
 */
export function isSameMinute(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}
