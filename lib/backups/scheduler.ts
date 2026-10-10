import { tickBackupJobs, tickRestoreDrills } from "./tick";
import { logger } from "@/lib/logger";

const log = logger.child("backup");

let interval: NodeJS.Timeout | null = null;
let drillInterval: NodeJS.Timeout | null = null;
let batchInterval: NodeJS.Timeout | null = null;

// Drills run hourly.
const DRILL_TICK_MS = 60 * 60_000;

export function startBackupScheduler(): void {
  if (interval) return;

  log.info("Scheduler started (60s interval)");
  interval = setInterval(async () => {
    try {
      await tickBackupJobs();
    } catch (err) {
      log.error("Tick error:", err);
    }
  }, 60_000);

  // Own timer: the backup tick waits on its runs.
  batchInterval = setInterval(async () => {
    try {
      const { flushBackupBatches } = await import("./batch");
      await flushBackupBatches();
    } catch (err) {
      log.error("Batch flush error:", err);
    }
  }, 60_000);

  // Own timer, so a slow drill can't delay a backup.
  drillInterval = setInterval(async () => {
    try {
      await tickRestoreDrills();
    } catch (err) {
      log.error("Drill tick error:", err);
    }
  }, DRILL_TICK_MS);
}

export function stopBackupScheduler(): void {
  if (batchInterval) {
    clearInterval(batchInterval);
    batchInterval = null;
  }
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
