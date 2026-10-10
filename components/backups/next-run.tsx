"use client";

import { Cron } from "croner";

/** Next fire time of a schedule read in `timeZone`. */
export function getNextRun(schedule: string, timeZone = "UTC"): Date | null {
  if (!schedule || schedule === "manual") return null;
  try {
    const job = new Cron(schedule, { timezone: timeZone });
    return job.nextRun() ?? null;
  } catch {
    return null;
  }
}

export function NextRun({ schedule, timeZone }: { schedule: string; timeZone?: string }) {
  const next = getNextRun(schedule, timeZone);
  if (!next) return <span className="text-muted-foreground">Manual</span>;

  const now = new Date();
  const diffMs = next.getTime() - now.getTime();
  const diffMins = Math.round(diffMs / 60000);

  let label: string;
  if (diffMins < 1) label = "< 1m";
  else if (diffMins < 60) label = `in ${diffMins}m`;
  else if (diffMins < 1440) label = `in ${Math.round(diffMins / 60)}h`;
  else label = next.toLocaleDateString();

  return (
    <span className="text-muted-foreground" title={next.toLocaleString()}>
      Next: {label}
    </span>
  );
}
