import { tickCronJobs } from "./engine";
import { logger } from "@/lib/logger";

const log = logger.child("cron");

let interval: NodeJS.Timeout | null = null;
let dailyInterval: NodeJS.Timeout | null = null;

export function startCronScheduler(): void {
  if (interval) return; // Already running

  log.info("Scheduler started (60s interval)");
  interval = setInterval(async () => {
    try {
      await tickCronJobs();
    } catch (err) {
      log.error("Tick error:", err);
    }
  }, 60_000); // Every minute

  startDailySecurityScans();
}

export function stopCronScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Scheduler stopped");
  }
  if (dailyInterval) {
    clearInterval(dailyInterval);
    dailyInterval = null;
  }
}

/**
 * Run security scans for all orgs once per day at 2 AM server time.
 * Checks every hour and fires when the current hour matches.
 */
function startDailySecurityScans(): void {
  if (dailyInterval) return;

  let lastScanDate: string | null = null;

  dailyInterval = setInterval(async () => {
    const now = new Date();
    if (now.getHours() !== 2) return;

    const today = now.toDateString();
    if (lastScanDate === today) return; // Already ran today
    lastScanDate = today;

    try {
      const { db } = await import("@/lib/db");
      const { organizations } = await import("@/lib/db/schema");
      const { runScheduledScans } = await import("@/lib/security/scanner");

      const orgs = await db.query.organizations.findMany({
        columns: { id: true },
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
  }, 60 * 60 * 1000); // Every hour
}
