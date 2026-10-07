import { dropStaleRetries, tickNotificationRetries } from "./retry";
import { logger } from "@/lib/logger";

const log = logger.child("notifications");

const TICK_MS = 30_000;
/** Retries due longer ago than this are dropped. */
export const STALE_RETRY_MS = 60 * 60_000;

let started = false;
let interval: NodeJS.Timeout | null = null;

/** Per process; the tick's Redis lock prevents double-sending. */
export async function startNotificationRetryScheduler(): Promise<void> {
  if (started) return;
  started = true;

  try {
    const dropped = await dropStaleRetries(STALE_RETRY_MS);
    if (dropped > 0) log.info(`Dropped ${dropped} queued notification retr${dropped === 1 ? "y" : "ies"} older than 1h`);
  } catch (err) {
    log.error("Stale retry cleanup failed:", err);
  }

  if (!started) return;
  interval = setInterval(async () => {
    try {
      await tickNotificationRetries();
    } catch (err) {
      log.error("Retry tick error:", err);
    }
  }, TICK_MS);
  log.info(`Retry scheduler started (${TICK_MS / 1000}s interval)`);
}

export function stopNotificationRetryScheduler(): void {
  started = false;
  if (interval) clearInterval(interval);
  interval = null;
}
