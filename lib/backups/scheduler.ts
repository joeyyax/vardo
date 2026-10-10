import { tickBackupJobs, tickRestoreDrills } from "./tick";
import { logger } from "@/lib/logger";

const log = logger.child("backup");

let interval: NodeJS.Timeout | null = null;
let drillInterval: NodeJS.Timeout | null = null;
let runInterval: NodeJS.Timeout | null = null;
let sweepInterval: NodeJS.Timeout | null = null;

// Drills run hourly.
const DRILL_TICK_MS = 60 * 60_000;

/** How often to look for backups a stopped console cut off. */
const SWEEP_TICK_MS = 5 * 60_000;

async function sweep(): Promise<void> {
  try {
    const { sweepInterruptedBackups } = await import("./requeue");
    await sweepInterruptedBackups();
  } catch (err) {
    log.error("Interrupted backup sweep error:", err);
  }
}

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

  // Own timer: the backup tick waits on its jobs.
  runInterval = setInterval(async () => {
    try {
      const { finishBackupRuns } = await import("./runs");
      await finishBackupRuns();
    } catch (err) {
      log.error("Backup run finish error:", err);
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

  // Picks up what the last console left: now, and after a self-deploy's old slot stops.
  void sweep();
  sweepInterval = setInterval(sweep, SWEEP_TICK_MS);
}

export function stopBackupScheduler(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
  if (runInterval) {
    clearInterval(runInterval);
    runInterval = null;
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
