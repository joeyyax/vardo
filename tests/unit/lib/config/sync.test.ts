import { beforeEach, describe, expect, it, vi } from "vitest";

const { invalidateSettingsCache, loadFeatureFlags, loadResourceSettings, publish } = vi.hoisted(() => ({
  invalidateSettingsCache: vi.fn(),
  loadFeatureFlags: vi.fn(async () => {}),
  loadResourceSettings: vi.fn(async () => ({})),
  publish: vi.fn(async () => 1),
}));

vi.mock("@/lib/system-settings", () => ({ invalidateSettingsCache }));
vi.mock("@/lib/config/features", () => ({ loadFeatureFlags, isFeatureEnabled: () => true }));
vi.mock("@/lib/resources/host", () => ({ loadResourceSettings, RESOURCE_SETTINGS_KEY: "resource_defaults" }));
vi.mock("@/lib/redis", () => ({ redis: { publish } }));

import { CONFIG_CHANNEL, publishConfigChange, reloadConfig } from "@/lib/config/sync";

describe("config sync", () => {
  beforeEach(() => vi.clearAllMocks());

  it("announces a changed setting on vardo:config", async () => {
    await publishConfigChange("feature_flags");
    expect(publish).toHaveBeenCalledWith(CONFIG_CHANNEL, JSON.stringify({ key: "feature_flags" }));
  });

  it("reloads the flag cache when flags change, and leaves resource settings alone", async () => {
    await reloadConfig("feature_flags");
    expect(invalidateSettingsCache).toHaveBeenCalledWith("feature_flags");
    expect(loadFeatureFlags).toHaveBeenCalledOnce();
    expect(loadResourceSettings).not.toHaveBeenCalled();
  });

  it("reloads resource settings when they change", async () => {
    await reloadConfig("resource_defaults");
    expect(loadResourceSettings).toHaveBeenCalledOnce();
    expect(loadFeatureFlags).not.toHaveBeenCalled();
  });

  it("drops one cached key for any other setting", async () => {
    await reloadConfig("instance_config");
    expect(invalidateSettingsCache).toHaveBeenCalledWith("instance_config");
    expect(loadFeatureFlags).not.toHaveBeenCalled();
    expect(loadResourceSettings).not.toHaveBeenCalled();
  });

  it("the periodic reload refreshes everything", async () => {
    await reloadConfig();
    expect(invalidateSettingsCache).toHaveBeenCalledWith(undefined);
    expect(loadFeatureFlags).toHaveBeenCalledOnce();
    expect(loadResourceSettings).toHaveBeenCalledOnce();
  });
});
