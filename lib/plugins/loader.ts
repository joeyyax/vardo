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

  // Monitoring — requires metrics, hooks into after.deploy.success
  try {
    const { registerMonitoringPlugin } = await import("./monitoring/register");
    await registerMonitoringPlugin();
  } catch (err) {
    log.error("Failed to register monitoring plugin:", err);
  }

  // SSL — hooks into before.cert.issue
  try {
    const { registerSslPlugin } = await import("./ssl/register");
    await registerSslPlugin();
  } catch (err) {
    log.error("Failed to register SSL plugin:", err);
  }

  // Git integration — GitHub OAuth, deploy keys, PR previews
  try {
    const { registerGitIntegrationPlugin } = await import("./git-integration/register");
    await registerGitIntegrationPlugin();
  } catch (err) {
    log.error("Failed to register git integration plugin:", err);
  }

  // Cron — scheduled task execution
  try {
    const { registerCronPlugin } = await import("./cron/register");
    await registerCronPlugin();
  } catch (err) {
    log.error("Failed to register cron plugin:", err);
  }

  // Domain monitoring — DNS health + cert expiration (requires SSL)
  try {
    const { registerDomainMonitoringPlugin } = await import("./domain-monitoring/register");
    await registerDomainMonitoringPlugin();
  } catch (err) {
    log.error("Failed to register domain monitoring plugin:", err);
  }

  // Digest — weekly summary email (requires cron + notifications + metrics)
  try {
    const { registerDigestPlugin } = await import("./digest/register");
    await registerDigestPlugin();
  } catch (err) {
    log.error("Failed to register digest plugin:", err);
  }

  // MCP server — AI agent access via Model Context Protocol
  try {
    const { registerMcpPlugin } = await import("./mcp/register");
    await registerMcpPlugin();
  } catch (err) {
    log.error("Failed to register MCP plugin:", err);
  }

  // Terminal — browser-based shell access to containers
  try {
    const { registerTerminalPlugin } = await import("./terminal/register");
    await registerTerminalPlugin();
  } catch (err) {
    log.error("Failed to register terminal plugin:", err);
  }

  log.info("Built-in plugin registration complete");
}
