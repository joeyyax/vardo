/** Cron expression utilities backed by croner. */

import { Cron } from "croner";

/** Whether the schedule fires at `now`. False for invalid expressions. */
export function shouldRunNow(schedule: string, now: Date): boolean {
  if (!schedule.trim()) return false;
  try {
    const job = new Cron(schedule.trim());
    // Ticks land mid-minute and croner matches only at :00; zero the seconds or jobs never fire.
    const atMinute = new Date(now);
    atMinute.setSeconds(0, 0);
    return job.match(atMinute);
  } catch {
    return false;
  }
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
