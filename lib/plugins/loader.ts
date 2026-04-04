// ---------------------------------------------------------------------------
// Plugin loader — registers all built-in plugins on app startup
//
// Each plugin has a register.ts that handles its own initialization.
// This module calls them in dependency order.
//
// NOTE: Imports must be static (not variable paths) because Turbopack
// cannot resolve dynamic import() expressions at build time.
// ---------------------------------------------------------------------------

import { logger } from "@/lib/logger";

const log = logger.child("plugins");

/** A registration function paired with its label for error reporting. */
type PluginEntry = [label: string, register: () => Promise<void>];

/**
 * Built-in plugins in dependency order — plugins that provide
 * capabilities required by others are registered first.
 */
const BUILT_IN_PLUGINS: PluginEntry[] = [
  ["notifications", async () => { const m = await import("./notifications/register"); await m.registerNotificationsPlugin(); }],
  ["metrics", async () => { const m = await import("./metrics/register"); await m.registerMetricsPlugin(); }],
  ["backups", async () => { const m = await import("./backups/register"); await m.registerBackupsPlugin(); }],
  ["security", async () => { const m = await import("./security/register"); await m.registerSecurityPlugin(); }],
  ["monitoring", async () => { const m = await import("./monitoring/register"); await m.registerMonitoringPlugin(); }],
  ["ssl", async () => { const m = await import("./ssl/register"); await m.registerSslPlugin(); }],
  ["git-integration", async () => { const m = await import("./git-integration/register"); await m.registerGitIntegrationPlugin(); }],
  ["cron", async () => { const m = await import("./cron/register"); await m.registerCronPlugin(); }],
  ["domain-monitoring", async () => { const m = await import("./domain-monitoring/register"); await m.registerDomainMonitoringPlugin(); }],
  ["digest", async () => { const m = await import("./digest/register"); await m.registerDigestPlugin(); }],
  ["mcp", async () => { const m = await import("./mcp/register"); await m.registerMcpPlugin(); }],
  ["terminal", async () => { const m = await import("./terminal/register"); await m.registerTerminalPlugin(); }],
  ["container-import", async () => { const m = await import("./container-import/register"); await m.registerContainerImportPlugin(); }],
  ["get-started", async () => { const m = await import("./get-started/register"); await m.registerGetStartedPlugin(); }],
  ["error-tracking", async () => { const m = await import("./error-tracking/register"); await m.registerErrorTrackingPlugin(); }],
  ["uptime", async () => { const m = await import("./uptime/register"); await m.registerUptimePlugin(); }],
  ["logging", async () => { const m = await import("./logging/register"); await m.registerLoggingPlugin(); }],
];

/**
 * Register all built-in plugins. Called once during app startup.
 */
export async function registerBuiltInPlugins(): Promise<void> {
  log.info("Registering built-in plugins...");

  for (const [label, register] of BUILT_IN_PLUGINS) {
    try {
      await register();
    } catch (err) {
      log.error(`Failed to register ${label} plugin:`, err);
    }
  }

  log.info("Built-in plugin registration complete");
}
