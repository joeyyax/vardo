import { Cron } from "croner";

/** Next fire time of a schedule read in `timeZone`. Null for a manual or unparseable schedule. */
export function getNextRun(schedule: string, timeZone = "UTC"): Date | null {
  if (!schedule || schedule === "manual") return null;
  try {
    return new Cron(schedule, { timezone: timeZone }).nextRun() ?? null;
  } catch {
    return null;
  }
}
