import { dropStaleRetries, tickNotificationRetries } from "./retry";
import { flushResolved } from "./resolved-hold";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("notifications");

const TICK_MS = 30_000;
/** Retries due longer ago than this are dropped. */
export const STALE_RETRY_MS = 60 * 60_000;

/** The tick's Redis lock still guards a send when leases are off. */
export const notificationRetryLoop = new IntervalLoop({
  name: "notification-retry",
  intervalMs: TICK_MS,
  log,
  prepare: async () => {
    try {
      const dropped = await dropStaleRetries(STALE_RETRY_MS);
      if (dropped > 0) log.info(`Dropped ${dropped} queued notification retr${dropped === 1 ? "y" : "ies"} older than 1h`);
    } catch (err) {
      log.error("Stale retry cleanup failed:", err);
    }
  },
  run: () => tickNotificationRetries(),
});

/** Sends held resolutions once their org goes quiet. */
export const resolvedFlushLoop = new IntervalLoop({
  name: "resolved-flush",
  intervalMs: TICK_MS,
  log,
  run: () => flushResolved(),
});
