import { tickNotificationRetries } from "./retry";
import { logger } from "@/lib/logger";

const log = logger.child("notifications");

let interval: NodeJS.Timeout | null = null;

export function startNotificationRetryScheduler(): void {
  if (interval) return;

  log.info("Retry scheduler started (30s interval)");
  interval = setInterval(async () => {
    try {
      await tickNotificationRetries();
    } catch (err) {
      log.error("Retry tick error:", err);
    }
  }, 30_000);
}
