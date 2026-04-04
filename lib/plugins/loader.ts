// ---------------------------------------------------------------------------
// Plugin loader — registers all built-in plugins on app startup
//
// Each plugin has a register.ts that handles its own initialization.
// This module calls them in dependency order.
// ---------------------------------------------------------------------------

import { logger } from "@/lib/logger";

const log = logger.child("plugins");

/**
 * Register all built-in plugins. Called once during app startup.
 * Plugins are registered in dependency order — plugins that provide
 * capabilities required by others are registered first.
 */
export async function registerBuiltInPlugins(): Promise<void> {
  log.info("Registering built-in plugins...");

  // Registration order: dependencies first

  // Notifications — no dependencies
  try {
    const { registerNotificationsPlugin } = await import("./notifications/register");
    await registerNotificationsPlugin();
  } catch (err) {
    log.error("Failed to register notifications plugin:", err);
  }

  // Metrics — requires redis
  try {
    const { registerMetricsPlugin } = await import("./metrics/register");
    await registerMetricsPlugin();
  } catch (err) {
    log.error("Failed to register metrics plugin:", err);
  }

  // Backups — requires redis, hooks into after.deploy.success
  try {
    const { registerBackupsPlugin } = await import("./backups/register");
    await registerBackupsPlugin();
  } catch (err) {
    log.error("Failed to register backups plugin:", err);
  }

  // Security scanner — hooks into after.deploy.success
  try {
    const { registerSecurityPlugin } = await import("./security/register");
    await registerSecurityPlugin();
  } catch (err) {
    log.error("Failed to register security plugin:", err);
  }

  log.info("Built-in plugin registration complete");
}
