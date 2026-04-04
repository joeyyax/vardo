import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const { dbMock, hookRegistrationRows } = vi.hoisted(() => {
  const hookRegistrationRows: { id: string; name: string; enabled: boolean }[] = [];

  const findFirstFn = vi.fn().mockResolvedValue(null);
  const findManyFn = vi.fn().mockResolvedValue([]);

  const queryPlugins = { findFirst: findFirstFn, findMany: findManyFn };
  const queryPluginSettings = { findFirst: vi.fn().mockResolvedValue(null) };
  const queryHookRegistrations = {
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn(async () => hookRegistrationRows),
  };

  // Chainable update: .update(table).set(data).where(condition)
  const updateWhereFn = vi.fn().mockResolvedValue(undefined);
  const updateSetFn = vi.fn(() => ({ where: updateWhereFn }));
  const updateFn = vi.fn(() => ({ set: updateSetFn }));

  // Chainable insert: .insert(table).values(data).onConflictDoNothing()
  const onConflictDoNothingFn = vi.fn().mockResolvedValue(undefined);
  const insertValuesFn = vi.fn(() => ({ onConflictDoNothing: onConflictDoNothingFn }));
  const insertFn = vi.fn(() => ({ values: insertValuesFn }));

  const dbMock = {
    query: {
      plugins: queryPlugins,
      pluginSettings: queryPluginSettings,
      hookRegistrations: queryHookRegistrations,
    },
    update: updateFn,
    insert: insertFn,
    _updateSet: updateSetFn,
    _updateWhere: updateWhereFn,
    _insertValues: insertValuesFn,
    _onConflictDoNothing: onConflictDoNothingFn,
  };

  return { dbMock, hookRegistrationRows };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/db/schema", () => ({
  plugins: { id: "plugins.id", enabled: "plugins.enabled" },
  pluginSettings: {
    id: "pluginSettings.id",
    pluginId: "pluginSettings.pluginId",
    organizationId: "pluginSettings.organizationId",
    key: "pluginSettings.key",
  },
  hookRegistrations: {
    id: "hookRegistrations.id",
    event: "hookRegistrations.event",
    name: "hookRegistrations.name",
  },
}));
vi.mock("@/lib/hooks/registry", () => ({ registerInternalHandler: vi.fn() }));
vi.mock("@/lib/plugins/compatibility", () => ({
  checkPluginCompatibility: vi.fn().mockResolvedValue({ compatible: true, issues: [] }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("nanoid", () => ({ nanoid: () => "test-id" }));

// drizzle-orm operators — return the args so we can inspect calls without real SQL
vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  isNull: (col: string) => ({ op: "isNull", col }),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import type { PluginManifest } from "@/lib/plugins/manifest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    description: "A test plugin",
    category: "testing",
    ...overrides,
  };
}

// We need to dynamically import because the module holds in-memory state
// (loadedPlugins map). Re-importing after resetModules gives us a fresh map.
async function freshRegistry() {
  const mod = await import("@/lib/plugins/registry");
  return mod;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Plugin Registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    hookRegistrationRows.length = 0;

    // Reset default mock behaviors
    dbMock.query.plugins.findFirst.mockResolvedValue(null);
    dbMock.query.plugins.findMany.mockResolvedValue([]);
    dbMock.query.pluginSettings.findFirst.mockResolvedValue(null);
    dbMock.query.hookRegistrations.findFirst.mockResolvedValue(null);
    dbMock.query.hookRegistrations.findMany.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // 1. Register a plugin
  // -------------------------------------------------------------------------

  describe("registerPlugin", () => {
    it("inserts a new plugin when it does not exist", async () => {
      const { registerPlugin } = await freshRegistry();
      const manifest = makeManifest();

      await registerPlugin(manifest);

      expect(dbMock.insert).toHaveBeenCalled();
      expect(dbMock._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "test-plugin",
          name: "Test Plugin",
          version: "1.0.0",
          enabled: true,
          builtIn: true,
        }),
      );
    });

    it("updates an existing plugin when the version changed", async () => {
      dbMock.query.plugins.findFirst.mockResolvedValueOnce({
        id: "test-plugin",
        version: "0.9.0",
        enabled: true,
      });

      const { registerPlugin } = await freshRegistry();
      const manifest = makeManifest({ version: "1.0.0" });

      await registerPlugin(manifest);

      expect(dbMock.update).toHaveBeenCalled();
      expect(dbMock._updateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Test Plugin",
          version: "1.0.0",
        }),
      );
    });

    it("skips registration when existing plugin is disabled", async () => {
      dbMock.query.plugins.findFirst.mockResolvedValueOnce({
        id: "test-plugin",
        version: "1.0.0",
        enabled: false,
      });

      const { registerPlugin, getPlugin } = await freshRegistry();
      const manifest = makeManifest();

      await registerPlugin(manifest);

      // Should not be in the in-memory cache
      expect(getPlugin("test-plugin")).toBeUndefined();
    });

    it("registers hooks from the manifest", async () => {
      const { registerPlugin } = await freshRegistry();
      const manifest = makeManifest({
        hooks: [
          { event: "after.deploy.success", handler: "onDeploy", priority: 50 },
        ],
      });

      await registerPlugin(manifest);

      // One insert for the plugin, one for the hook
      expect(dbMock.insert).toHaveBeenCalledTimes(2);
    });

    it("does not duplicate existing hooks on re-registration", async () => {
      // First call: plugin doesn't exist
      dbMock.query.plugins.findFirst.mockResolvedValueOnce(null);
      // Hook already registered
      dbMock.query.hookRegistrations.findFirst.mockResolvedValueOnce({
        id: "existing-hook",
        event: "after.deploy.success",
        name: "test-plugin:onDeploy",
      });

      const { registerPlugin } = await freshRegistry();
      const manifest = makeManifest({
        hooks: [
          { event: "after.deploy.success", handler: "onDeploy" },
        ],
      });

      await registerPlugin(manifest);

      // Only one insert: the plugin itself, no hook insert
      expect(dbMock.insert).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Idempotent registration
  // -------------------------------------------------------------------------

  describe("idempotent registration", () => {
    it("updates instead of duplicating when re-registering same plugin with new version", async () => {
      dbMock.query.plugins.findFirst.mockResolvedValueOnce({
        id: "test-plugin",
        version: "1.0.0",
        enabled: true,
      });

      const { registerPlugin } = await freshRegistry();
      const manifest = makeManifest({ version: "2.0.0" });

      await registerPlugin(manifest);

      // Should update, not insert
      expect(dbMock.update).toHaveBeenCalled();
      expect(dbMock._updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ version: "2.0.0" }),
      );
    });

    it("does not update when version is unchanged", async () => {
      dbMock.query.plugins.findFirst.mockResolvedValueOnce({
        id: "test-plugin",
        version: "1.0.0",
        enabled: true,
      });

      const { registerPlugin } = await freshRegistry();
      const manifest = makeManifest({ version: "1.0.0" });

      await registerPlugin(manifest);

      // Should not call update (version didn't change)
      expect(dbMock.update).not.toHaveBeenCalled();
      // But it should not insert either (already exists)
      expect(dbMock.insert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Enable a plugin
  // -------------------------------------------------------------------------

  describe("enablePlugin", () => {
    it("sets enabled=true and registers hooks", async () => {
      dbMock.query.plugins.findFirst.mockResolvedValueOnce({
        id: "test-plugin",
        manifest: makeManifest({
          hooks: [{ event: "before.deploy", handler: "check" }],
        }),
      });

      const { enablePlugin, getPlugin } = await freshRegistry();

      await enablePlugin("test-plugin");

      expect(dbMock.update).toHaveBeenCalled();
      expect(dbMock._updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      );
      // Plugin should now be in the in-memory cache
      expect(getPlugin("test-plugin")).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Disable a plugin
  // -------------------------------------------------------------------------

  describe("disablePlugin", () => {
    it("sets enabled=false and disables associated hooks", async () => {
      // Populate hook rows that the disable function will iterate
      hookRegistrationRows.push(
        { id: "hook-1", name: "test-plugin:onDeploy", enabled: true },
        { id: "hook-2", name: "other-plugin:handler", enabled: true },
      );
      dbMock.query.hookRegistrations.findMany.mockResolvedValueOnce([...hookRegistrationRows]);

      const { registerPlugin, disablePlugin, getPlugin } = await freshRegistry();

      // First register so it's in the in-memory cache
      await registerPlugin(makeManifest());
      vi.clearAllMocks();

      await disablePlugin("test-plugin");

      // Should update the plugin row
      expect(dbMock.update).toHaveBeenCalled();
      expect(dbMock._updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );

      // Should remove from in-memory cache
      expect(getPlugin("test-plugin")).toBeUndefined();
    });

    it("only disables hooks belonging to the target plugin", async () => {
      hookRegistrationRows.push(
        { id: "hook-1", name: "test-plugin:onDeploy", enabled: true },
        { id: "hook-2", name: "other-plugin:handler", enabled: true },
      );
      dbMock.query.hookRegistrations.findMany.mockResolvedValueOnce([...hookRegistrationRows]);

      const { disablePlugin } = await freshRegistry();

      await disablePlugin("test-plugin");

      // update called: once for plugin enabled=false, once for hook-1 disable
      // hook-2 belongs to other-plugin and should not be disabled
      const updateSetCalls = dbMock._updateSet.mock.calls;
      const hookDisableCalls = updateSetCalls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).enabled === false,
      );
      // One for the plugin itself, one for hook-1
      expect(hookDisableCalls.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Get enabled plugins
  // -------------------------------------------------------------------------

  describe("getEnabledPlugins", () => {
    it("returns plugins from in-memory cache when populated", async () => {
      const { registerPlugin, getEnabledPlugins } = await freshRegistry();
      const manifest = makeManifest();

      await registerPlugin(manifest);

      const enabled = await getEnabledPlugins();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].id).toBe("test-plugin");
      // Should not query the DB since cache is populated
      expect(dbMock.query.plugins.findMany).not.toHaveBeenCalled();
    });

    it("queries the database when cache is empty", async () => {
      dbMock.query.plugins.findMany.mockResolvedValueOnce([
        { manifest: makeManifest({ id: "plugin-a" }) },
        { manifest: makeManifest({ id: "plugin-b" }) },
      ]);

      const { getEnabledPlugins } = await freshRegistry();

      const enabled = await getEnabledPlugins();
      expect(enabled).toHaveLength(2);
      expect(dbMock.query.plugins.findMany).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Capability queries
  // -------------------------------------------------------------------------

  describe("isCapabilityAvailable", () => {
    it("returns true when a loaded plugin provides the capability", async () => {
      const { registerPlugin, isCapabilityAvailable } = await freshRegistry();
      await registerPlugin(makeManifest({ provides: ["metrics", "alerting"] }));

      expect(await isCapabilityAvailable("metrics")).toBe(true);
      expect(await isCapabilityAvailable("alerting")).toBe(true);
    });

    it("returns false when no plugin provides the capability", async () => {
      const { registerPlugin, isCapabilityAvailable } = await freshRegistry();
      await registerPlugin(makeManifest({ provides: ["metrics"] }));

      expect(await isCapabilityAvailable("backups")).toBe(false);
    });

    it("returns false when no plugins are loaded", async () => {
      const { isCapabilityAvailable } = await freshRegistry();
      dbMock.query.plugins.findMany.mockResolvedValueOnce([]);

      expect(await isCapabilityAvailable("anything")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Plugin settings CRUD
  // -------------------------------------------------------------------------

  describe("getPluginSetting", () => {
    it("returns org-level setting when available", async () => {
      dbMock.query.pluginSettings.findFirst.mockResolvedValueOnce({
        value: "org-value",
      });

      const { getPluginSetting } = await freshRegistry();
      const result = await getPluginSetting("test-plugin", "api_key", "org-1");

      expect(result).toBe("org-value");
    });

    it("falls back to system-level setting when no org setting exists", async () => {
      // First call (org-level) returns null
      dbMock.query.pluginSettings.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ value: "system-value" });

      const { getPluginSetting } = await freshRegistry();
      const result = await getPluginSetting("test-plugin", "api_key", "org-1");

      expect(result).toBe("system-value");
    });

    it("returns null when no setting exists at any level", async () => {
      dbMock.query.pluginSettings.findFirst.mockResolvedValue(null);

      const { getPluginSetting } = await freshRegistry();
      const result = await getPluginSetting("test-plugin", "missing_key");

      expect(result).toBeNull();
    });
  });

  describe("setPluginSetting", () => {
    it("inserts a new setting when it does not exist", async () => {
      dbMock.query.pluginSettings.findFirst.mockResolvedValueOnce(null);

      const { setPluginSetting } = await freshRegistry();
      await setPluginSetting("test-plugin", "api_key", "secret-123");

      expect(dbMock.insert).toHaveBeenCalled();
      expect(dbMock._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "test-plugin",
          key: "api_key",
          value: "secret-123",
        }),
      );
    });

    it("updates an existing setting", async () => {
      dbMock.query.pluginSettings.findFirst.mockResolvedValueOnce({
        id: "setting-1",
        value: "old-value",
      });

      const { setPluginSetting } = await freshRegistry();
      await setPluginSetting("test-plugin", "api_key", "new-value");

      expect(dbMock.update).toHaveBeenCalled();
      expect(dbMock._updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ value: "new-value" }),
      );
    });

    it("scopes settings to organization when orgId is provided", async () => {
      dbMock.query.pluginSettings.findFirst.mockResolvedValueOnce(null);

      const { setPluginSetting } = await freshRegistry();
      await setPluginSetting("test-plugin", "api_key", "val", "org-1");

      expect(dbMock._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
        }),
      );
    });

    it("uses null organizationId for system-level settings", async () => {
      dbMock.query.pluginSettings.findFirst.mockResolvedValueOnce(null);

      const { setPluginSetting } = await freshRegistry();
      await setPluginSetting("test-plugin", "api_key", "val");

      expect(dbMock._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: null,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 8. getPlugin (in-memory lookup)
  // -------------------------------------------------------------------------

  describe("getPlugin", () => {
    it("returns the manifest for a registered plugin", async () => {
      const { registerPlugin, getPlugin } = await freshRegistry();
      const manifest = makeManifest();

      await registerPlugin(manifest);

      const result = getPlugin("test-plugin");
      expect(result).toBeDefined();
      expect(result?.id).toBe("test-plugin");
      expect(result?.version).toBe("1.0.0");
    });

    it("returns undefined for an unregistered plugin", async () => {
      const { getPlugin } = await freshRegistry();
      expect(getPlugin("nonexistent")).toBeUndefined();
    });
  });
});
