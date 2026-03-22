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
    return job.match(now);
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
