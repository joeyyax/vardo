import { tickBackupJobs, tickRestoreDrills } from "./tick";
import { logger } from "@/lib/logger";

const log = logger.child("backup");

let interval: NodeJS.Timeout | null = null;
let drillInterval: NodeJS.Timeout | null = null;

// Drills are hourly, not per-minute. Each costs a container and a download,
// and a verification stands for a week.
const DRILL_TICK_MS = 60 * 60_000;

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

  // On its own timer, so a slow drill cannot delay a backup.
  drillInterval = setInterval(async () => {
    try {
      await tickRestoreDrills();
    } catch (err) {
      log.error("Drill tick error:", err);
    }
  }, DRILL_TICK_MS);
}

export function stopBackupScheduler(): void {
  if (drillInterval) {
    clearInterval(drillInterval);
    drillInterval = null;
  }
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Scheduler stopped");
  }
}
