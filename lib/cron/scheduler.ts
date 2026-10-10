import { tickCronJobs } from "./engine";
import { logger } from "@/lib/logger";
import { isFeatureEnabled } from "@/lib/config/features";
import { cleanupStaleSelfPreviews } from "@/lib/docker/self-preview";
import { getSystemSettingRaw, invalidateSettingsCache, setSystemSetting } from "@/lib/system-settings";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("cron");

/** The server-local date the daily jobs last ran, so a restart or a second process doesn't run them twice. */
export const DAILY_SCAN_DATE_KEY = "cron_daily_scan_date";

// Each pass waits on the jobs it starts, so a long job can't hold back the next minute.
export const cronTickLoop = new IntervalLoop({
  name: "cron-tick",
  intervalMs: 60_000,
  overlap: true,
  log,
  run: () => tickCronJobs(),
});

/** Security scans for every org and stale self-preview cleanup, once a day at 2 AM server time. */
export async function runDailyJobs(now = new Date()): Promise<boolean> {
  if (now.getHours() !== 2) return false;

  const today = now.toDateString();
  invalidateSettingsCache(DAILY_SCAN_DATE_KEY);
  if ((await getSystemSettingRaw(DAILY_SCAN_DATE_KEY)) === today) return false;
  await setSystemSetting(DAILY_SCAN_DATE_KEY, today);

  if (isFeatureEnabled("security")) {
    try {
      const { db } = await import("@/lib/db");
      const { runScheduledScans } = await import("@/lib/security/scanner");

      const orgs = await db.query.organizations.findMany({
        columns: { id: true },
        limit: 500,
      });

      log.info(`Daily security scan: scanning ${orgs.length} organizations`);

      for (const org of orgs) {
        await runScheduledScans(org.id).catch((err) => {
          log.error(`Daily scan failed for org ${org.id}:`, err);
        });
      }
    } catch (err) {
      log.error("Daily security scan error:", err);
    }
  }

  // Self-preview containers join the production network; reap them if a PR close webhook was missed.
  if (isFeatureEnabled("selfManagement") && isFeatureEnabled("previews")) {
    try {
      const cleaned = await cleanupStaleSelfPreviews();
      if (cleaned > 0) {
        log.info(`Cleaned up ${cleaned} stale self-preview(s)`);
      }
    } catch (err) {
      log.error("Stale self-preview cleanup error:", err);
    }
  }
  return true;
}

export const cronDailyLoop = new IntervalLoop({
  name: "cron-daily",
  intervalMs: 60 * 60 * 1000,
  log,
  run: () => runDailyJobs(),
});
