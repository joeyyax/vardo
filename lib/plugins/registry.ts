// ---------------------------------------------------------------------------
// Plugin registry — load, register, enable/disable plugins
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { plugins, pluginSettings } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { PluginManifest } from "./manifest";
import { registerInternalHandler } from "@/lib/hooks/registry";
import { hookRegistrations } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

const log = logger.child("plugins");

/** In-memory cache of loaded plugins. */
const loadedPlugins = new Map<string, PluginManifest>();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a plugin. Creates the DB record if it doesn't exist,
 * updates it if the version changed, and registers its hooks.
 */
export async function registerPlugin(manifest: PluginManifest): Promise<void> {
  const existing = await db.query.plugins.findFirst({
    where: eq(plugins.id, manifest.id),
  });

  if (existing) {
    // Update if version changed
    if (existing.version !== manifest.version) {
      await db.update(plugins).set({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        category: manifest.category,
        manifest: manifest as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      }).where(eq(plugins.id, manifest.id));
      log.info(`Updated plugin ${manifest.id} to v${manifest.version}`);
    }

    // Skip if disabled
    if (!existing.enabled) {
      log.info(`Plugin ${manifest.id} is disabled, skipping registration`);
      return;
    }
  } else {
    // New plugin — insert
    await db.insert(plugins).values({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      category: manifest.category,
      manifest: manifest as unknown as Record<string, unknown>,
      enabled: true,
      builtIn: true,
    });
    log.info(`Registered plugin ${manifest.id} v${manifest.version}`);
  }

  // Register hooks from manifest
  if (manifest.hooks?.length) {
    await registerPluginHooks(manifest);
  }

  loadedPlugins.set(manifest.id, manifest);
}

/**
 * Register all hooks declared in a plugin's manifest.
 * Creates hook_registration rows linked to the plugin.
 */
async function registerPluginHooks(manifest: PluginManifest): Promise<void> {
  if (!manifest.hooks) return;

  for (const hook of manifest.hooks) {
    // Check if this hook is already registered
    const existing = await db.query.hookRegistrations.findFirst({
      where: and(
        eq(hookRegistrations.event, hook.event),
        eq(hookRegistrations.name, `${manifest.id}:${hook.handler}`),
      ),
    });

    if (existing) continue;

    await db.insert(hookRegistrations).values({
      id: nanoid(),
      event: hook.event,
      name: `${manifest.id}:${hook.handler}`,
      type: "internal",
      config: { handler: `${manifest.id}:${hook.handler}` },
      priority: hook.priority ?? 100,
      failMode: hook.failMode ?? "warn",
      enabled: true,
      builtIn: true,
    }).onConflictDoNothing();
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** Get all registered and enabled plugins. */
export async function getEnabledPlugins(): Promise<PluginManifest[]> {
  if (loadedPlugins.size > 0) {
    return Array.from(loadedPlugins.values());
  }

  const rows = await db.query.plugins.findMany({
    where: eq(plugins.enabled, true),
  });

  const manifests: PluginManifest[] = [];
  for (const row of rows) {
    const manifest = row.manifest as unknown as PluginManifest;
    loadedPlugins.set(manifest.id, manifest);
    manifests.push(manifest);
  }

  return manifests;
}

/** Get a single plugin's manifest by ID. */
export function getPlugin(pluginId: string): PluginManifest | undefined {
  return loadedPlugins.get(pluginId);
}

/** Check if a capability is provided by any enabled plugin. */
export async function isCapabilityAvailable(capability: string): Promise<boolean> {
  const enabled = await getEnabledPlugins();
  return enabled.some((p) => p.provides?.includes(capability));
}

// ---------------------------------------------------------------------------
// Enable / Disable
// ---------------------------------------------------------------------------

/** Enable a plugin. Registers its hooks. */
export async function enablePlugin(pluginId: string): Promise<void> {
  await db.update(plugins).set({ enabled: true, updatedAt: new Date() }).where(eq(plugins.id, pluginId));

  const row = await db.query.plugins.findFirst({ where: eq(plugins.id, pluginId) });
  if (row) {
    const manifest = row.manifest as unknown as PluginManifest;
    await registerPluginHooks(manifest);
    loadedPlugins.set(pluginId, manifest);
    log.info(`Enabled plugin ${pluginId}`);
  }
}

/** Disable a plugin. Disables its hooks but doesn't delete them. */
export async function disablePlugin(pluginId: string): Promise<void> {
  await db.update(plugins).set({ enabled: false, updatedAt: new Date() }).where(eq(plugins.id, pluginId));

  // Disable all hooks registered by this plugin
  const hookPrefix = `${pluginId}:`;
  const hooks = await db.query.hookRegistrations.findMany();
  for (const hook of hooks) {
    if (hook.name.startsWith(hookPrefix)) {
      await db.update(hookRegistrations).set({ enabled: false }).where(eq(hookRegistrations.id, hook.id));
    }
  }

  loadedPlugins.delete(pluginId);
  log.info(`Disabled plugin ${pluginId}`);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Get a plugin setting value (org-scoped, falls back to system-level). */
export async function getPluginSetting(
  pluginId: string,
  key: string,
  organizationId?: string,
): Promise<string | null> {
  // Try org-level first
  if (organizationId) {
    const orgSetting = await db.query.pluginSettings.findFirst({
      where: and(
        eq(pluginSettings.pluginId, pluginId),
        eq(pluginSettings.organizationId, organizationId),
        eq(pluginSettings.key, key),
      ),
    });
    if (orgSetting) return orgSetting.value;
  }

  // Fall back to system-level
  const systemSetting = await db.query.pluginSettings.findFirst({
    where: and(
      eq(pluginSettings.pluginId, pluginId),
      isNull(pluginSettings.organizationId),
      eq(pluginSettings.key, key),
    ),
  });

  return systemSetting?.value ?? null;
}

/** Set a plugin setting value. */
export async function setPluginSetting(
  pluginId: string,
  key: string,
  value: string,
  organizationId?: string,
): Promise<void> {
  const existing = await db.query.pluginSettings.findFirst({
    where: and(
      eq(pluginSettings.pluginId, pluginId),
      organizationId ? eq(pluginSettings.organizationId, organizationId) : isNull(pluginSettings.organizationId),
      eq(pluginSettings.key, key),
    ),
  });

  if (existing) {
    await db.update(pluginSettings).set({ value, updatedAt: new Date() }).where(eq(pluginSettings.id, existing.id));
  } else {
    await db.insert(pluginSettings).values({
      id: nanoid(),
      pluginId,
      organizationId: organizationId ?? null,
      key,
      value,
    });
  }
}
