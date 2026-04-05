import { startNotificationConsumer, stopNotificationConsumer } from "@/lib/notifications/stream-consumer";
import { logger } from "@/lib/logger";

const log = logger.child("notifications");

/**
 * Start the notification stream consumer.
 */
export async function registerNotificationsPlugin(): Promise<void> {
  startNotificationConsumer().catch((err) => {
    log.error("Failed to start notification consumer:", err);
  });

  log.info("Notification consumer started");
}

/** Graceful shutdown. */
export async function stopNotificationsPlugin(): Promise<void> {
  await stopNotificationConsumer();
}
