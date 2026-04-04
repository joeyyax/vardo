// ---------------------------------------------------------------------------
// Notifications plugin registration
//
// Registers the notifications plugin and starts its stream consumer.
// This is called during app startup to activate the plugin.
// ---------------------------------------------------------------------------

import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { startNotificationConsumer, stopNotificationConsumer } from "@/lib/notifications/stream-consumer";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:notifications");

/**
 * Register and start the notifications plugin.
 * - Registers the plugin manifest (creates DB record if needed)
 * - Starts the Redis Stream consumer for notification dispatch
 */
export async function registerNotificationsPlugin(): Promise<void> {
  await registerPlugin(manifest);
  log.info("Notifications plugin registered");

  // Start the stream consumer (non-blocking)
  startNotificationConsumer().catch((err) => {
    log.error("Failed to start notification consumer:", err);
  });
}

/** Graceful shutdown. */
export async function stopNotificationsPlugin(): Promise<void> {
  await stopNotificationConsumer();
}
