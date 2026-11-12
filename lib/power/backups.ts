// The backup policy's record: scheduled jobs skipped on battery.

import { plural } from "@/lib/email/format";
import { recordPowerAction } from "./actions";

export async function recordBackupsSkipped(jobNames: string[], outage: string | null, now = new Date()): Promise<void> {
  const n = jobNames.length;
  await recordPowerAction(
    {
      kind: "backups-skipped",
      title: `Skipped ${plural(n, "backup")} on battery`,
      message: `The host is on battery, so ${n === 1 ? "this scheduled backup was" : "these scheduled backups were"} skipped: ${jobNames.join(", ")}. ${n === 1 ? "It runs" : "They run"} at the next scheduled time on mains power.`,
      outage,
      count: n,
      detail: { names: jobNames },
      notify: "throttled",
    },
    now,
  );
}
