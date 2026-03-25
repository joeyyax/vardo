import { tickBackupJobs } from "./tick";
import { logger } from "@/lib/logger";

const log = logger.child("backup");

let interval: NodeJS.Timeout | null = null;

export function startBackupScheduler(): void {
  if (interval) return; // Already running

  log.info("Scheduler started (60s interval)");
  interval = setInterval(async () => {
    try {
      await tickBackupJobs();
    } catch (err) {
      log.error("Tick error:", err);
    }
  }, 60_000); // Every minute
}

export function stopBackupScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Scheduler stopped");
  }
}
