import { cleanupExpiredPreviews } from "./preview";
import { logger } from "@/lib/logger";

const log = logger.child("preview-sweeper");

/** Previews outlive their expiry by at most this long. */
const SWEEP_INTERVAL_MS = 15 * 60_000;

let interval: NodeJS.Timeout | null = null;

async function sweep(): Promise<void> {
  try {
    const cleaned = await cleanupExpiredPreviews();
    if (cleaned > 0) log.info(`Destroyed ${cleaned} expired preview(s)`);
  } catch (err) {
    log.error("Sweep error:", err);
  }
}

export function startPreviewSweeper(): void {
  if (interval) return;

  log.info("Preview sweeper started (15m interval)");
  // Sweep on boot: an instance that was down past an expiry would otherwise
  // wait a full interval, and previews have been outliving expiry for months.
  void sweep();
  interval = setInterval(sweep, SWEEP_INTERVAL_MS);
}

export function stopPreviewSweeper(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Preview sweeper stopped");
  }
}
