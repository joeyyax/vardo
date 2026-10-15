import { describe, it, expect, vi, beforeEach } from "vitest";

const { settings } = vi.hoisted(() => ({ settings: new Map<string, string>() }));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: vi.fn(async (key: string) => settings.get(key) ?? null),
  setSystemSetting: vi.fn(async (key: string, value: string) => void settings.set(key, value)),
}));

import { getDiskMetricsEnabled, setDiskMetricsEnabled } from "@/lib/metrics/disk-setting";

describe("Disk metrics setting", () => {
  beforeEach(() => settings.clear());

  it("is off by default", async () => {
    expect(await getDiskMetricsEnabled()).toBe(false);
  });

  it("carries the old cAdvisor-era value over once", async () => {
    settings.set("cadvisor_config", JSON.stringify({ diskMetricsEnabled: true }));
    expect(await getDiskMetricsEnabled()).toBe(true);
    expect(settings.get("metrics_disk")).toBe("true");

    settings.set("cadvisor_config", JSON.stringify({ diskMetricsEnabled: false }));
    expect(await getDiskMetricsEnabled()).toBe(true);
  });

  it("reads what was saved", async () => {
    await setDiskMetricsEnabled(true);
    expect(await getDiskMetricsEnabled()).toBe(true);
    await setDiskMetricsEnabled(false);
    expect(await getDiskMetricsEnabled()).toBe(false);
  });
});
