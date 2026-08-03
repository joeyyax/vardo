import {
  sweepStuckDeployments,
  sweepStuckQueuedDeployments,
  sweepRollbackWatches,
} from "./sweeper";
import { logger } from "@/lib/logger";

const log = logger.child("deploy-sweeper");

/** Shorter than the main sweep — the default grace period is only 60s. */
const ROLLBACK_INTERVAL_MS = 15_000;

let interval: NodeJS.Timeout | null = null;
let rollbackInterval: NodeJS.Timeout | null = null;
let rollbackTicking = false;

export function startDeploySweeper(): void {
  if (interval) return; // Already running

  log.info("Deploy sweeper started (60s interval, 15s rollback watch)");
  interval = setInterval(async () => {
    try {
      await sweepStuckDeployments();
      await sweepStuckQueuedDeployments();
    } catch (err) {
      log.error("Sweep error:", err);
    }
  }, 60_000); // Every minute

  rollbackInterval = setInterval(async () => {
    if (rollbackTicking) return;
    rollbackTicking = true;
    try {
      await sweepRollbackWatches();
    } catch (err) {
      log.error("Rollback watch error:", err);
    } finally {
      rollbackTicking = false;
    }
  }, ROLLBACK_INTERVAL_MS);
}

export function stopDeploySweeper(): void {
  if (rollbackInterval) {
    clearInterval(rollbackInterval);
    rollbackInterval = null;
  }
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Deploy sweeper stopped");
  }
}
