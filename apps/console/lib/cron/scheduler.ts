import { tickCronJobs } from "./engine";
import { logger } from "@/lib/logger";

const log = logger.child("cron");

let interval: NodeJS.Timeout | null = null;

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
}

export function stopCronScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Scheduler stopped");
  }
}
