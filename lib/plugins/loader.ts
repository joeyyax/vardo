// ---------------------------------------------------------------------------
// Plugin loader — registers all built-in plugins on app startup
//
// Each plugin has a register.ts that handles its own initialization.
// This module calls them in dependency order.
// ---------------------------------------------------------------------------

import { logger } from "@/lib/logger";

const log = logger.child("plugins");

/**
 * Built-in plugins listed in dependency order — plugins that provide
 * capabilities required by others are registered first.
 */
const BUILT_IN_PLUGINS = [
  { path: "./notifications/register", fn: "registerNotificationsPlugin", label: "notifications" },
  { path: "./metrics/register", fn: "registerMetricsPlugin", label: "metrics" },
  { path: "./backups/register", fn: "registerBackupsPlugin", label: "backups" },
  { path: "./security/register", fn: "registerSecurityPlugin", label: "security" },
  { path: "./monitoring/register", fn: "registerMonitoringPlugin", label: "monitoring" },
  { path: "./ssl/register", fn: "registerSslPlugin", label: "SSL" },
  { path: "./git-integration/register", fn: "registerGitIntegrationPlugin", label: "git integration" },
  { path: "./cron/register", fn: "registerCronPlugin", label: "cron" },
  { path: "./domain-monitoring/register", fn: "registerDomainMonitoringPlugin", label: "domain monitoring" },
  { path: "./digest/register", fn: "registerDigestPlugin", label: "digest" },
  { path: "./mcp/register", fn: "registerMcpPlugin", label: "MCP" },
  { path: "./terminal/register", fn: "registerTerminalPlugin", label: "terminal" },
  { path: "./container-import/register", fn: "registerContainerImportPlugin", label: "container-import" },
  { path: "./get-started/register", fn: "registerGetStartedPlugin", label: "get-started" },
  { path: "./error-tracking/register", fn: "registerErrorTrackingPlugin", label: "error-tracking" },
  { path: "./uptime/register", fn: "registerUptimePlugin", label: "uptime" },
  { path: "./logging/register", fn: "registerLoggingPlugin", label: "logging" },
];

/**
 * Register all built-in plugins. Called once during app startup.
 * Plugins are registered in dependency order — plugins that provide
 * capabilities required by others are registered first.
 */
export async function registerBuiltInPlugins(): Promise<void> {
  log.info("Registering built-in plugins...");

  for (const plugin of BUILT_IN_PLUGINS) {
    try {
      const mod = await import(plugin.path);
      await mod[plugin.fn]();
    } catch (err) {
      log.error(`Failed to register ${plugin.label} plugin:`, err);
    }
  }

  log.info("Built-in plugin registration complete");
}
