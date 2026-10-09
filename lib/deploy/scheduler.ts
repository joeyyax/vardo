import {
  sweepStuckDeployments,
  sweepStuckQueuedDeployments,
  sweepRollbackWatches,
  sweepStandbySlots,
} from "./sweeper";
import { sweepDeployStreams } from "@/lib/stream/deploy-expiry";
import { logger } from "@/lib/logger";

const log = logger.child("deploy-sweeper");

/** Shorter than the main sweep; the default grace period is 60s. */
const ROLLBACK_INTERVAL_MS = 15_000;

const STANDBY_INTERVAL_MS = 5 * 60_000;

const STREAM_EXPIRY_INTERVAL_MS = 60 * 60_000;

let interval: NodeJS.Timeout | null = null;
let rollbackInterval: NodeJS.Timeout | null = null;
let rollbackTicking = false;
let standbyInterval: NodeJS.Timeout | null = null;
let standbyTicking = false;
let streamExpiryInterval: NodeJS.Timeout | null = null;
let streamExpiryTicking = false;

async function tickStreamExpiry(): Promise<void> {
  if (streamExpiryTicking) return;
  streamExpiryTicking = true;
  try {
    await sweepDeployStreams();
  } catch (err) {
    log.error("Deploy stream expiry error:", err);
  } finally {
    streamExpiryTicking = false;
  }
}

export function startDeploySweeper(): void {
  if (interval) return;

  log.info("Deploy sweeper started (60s interval, 15s rollback watch, 5m standby sweep, 1h stream expiry)");
  interval = setInterval(async () => {
    try {
      await sweepStuckDeployments();
      await sweepStuckQueuedDeployments();
    } catch (err) {
      log.error("Sweep error:", err);
    }
  }, 60_000);

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

  standbyInterval = setInterval(async () => {
    if (standbyTicking) return;
    standbyTicking = true;
    try {
      await sweepStandbySlots();
    } catch (err) {
      log.error("Standby sweep error:", err);
    } finally {
      standbyTicking = false;
    }
  }, STANDBY_INTERVAL_MS);

  // Boot sweep catches streams left without an expiry.
  void tickStreamExpiry();
  streamExpiryInterval = setInterval(tickStreamExpiry, STREAM_EXPIRY_INTERVAL_MS);
}

export function stopDeploySweeper(): void {
  if (streamExpiryInterval) {
    clearInterval(streamExpiryInterval);
    streamExpiryInterval = null;
  }
  if (standbyInterval) {
    clearInterval(standbyInterval);
    standbyInterval = null;
  }
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
