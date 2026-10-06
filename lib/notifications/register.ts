import { startNotificationConsumer, stopNotificationConsumer } from "@/lib/notifications/stream-consumer";
import { startNotificationRetryScheduler, stopNotificationRetryScheduler } from "@/lib/notifications/scheduler";
import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("notifications");

/**
 * Start the notification stream consumer and the retry scheduler.
 */
export async function registerNotificationsPlugin(): Promise<void> {
  if (!isFeatureEnabled("notifications")) {
    log.info("Notifications disabled, skipping registration");
    return;
  }

  startNotificationConsumer().catch((err) => {
    log.error("Failed to start notification consumer:", err);
  });

  log.info("Notification consumer started");

  startNotificationRetryScheduler().catch((err) => {
    log.error("Failed to start notification retry scheduler:", err);
  });
}

/** Graceful shutdown. */
export async function stopNotificationsPlugin(): Promise<void> {
  stopNotificationRetryScheduler();
  await stopNotificationConsumer();
}
