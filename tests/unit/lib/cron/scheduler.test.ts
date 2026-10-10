import { describe, it, expect, vi, beforeEach } from "vitest";

const { isFeatureEnabledMock, cleanupStaleSelfPreviewsMock, settings } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn().mockReturnValue(false),
  cleanupStaleSelfPreviewsMock: vi.fn().mockResolvedValue(0),
  settings: new Map<string, string>(),
}));

vi.mock("@/lib/config/features", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

vi.mock("@/lib/docker/self-preview", () => ({
  cleanupStaleSelfPreviews: cleanupStaleSelfPreviewsMock,
}));

vi.mock("@/lib/cron/engine", () => ({
  tickCronJobs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: vi.fn(async (key: string) => settings.get(key) ?? null),
  setSystemSetting: vi.fn(async (key: string, value: string) => void settings.set(key, value)),
  invalidateSettingsCache: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      organizations: {
        findMany: vi.fn(async () => []),
      },
    },
  },
}));

vi.mock("@/lib/security/scanner", () => ({
  runScheduledScans: vi.fn().mockResolvedValue(undefined),
}));

import { runDailyJobs, DAILY_SCAN_DATE_KEY } from "@/lib/cron/scheduler";

const at = (hour: number) => {
  const d = new Date(2026, 9, 10);
  d.setHours(hour, 0, 0, 0);
  return d;
};

describe("daily cron jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.clear();
  });

  it("calls cleanupStaleSelfPreviews when selfManagement is enabled", async () => {
    isFeatureEnabledMock.mockReturnValue(true);
    expect(await runDailyJobs(at(2))).toBe(true);
    expect(cleanupStaleSelfPreviewsMock).toHaveBeenCalledOnce();
  });

  it("skips cleanupStaleSelfPreviews when selfManagement is disabled", async () => {
    isFeatureEnabledMock.mockReturnValue(false);
    await runDailyJobs(at(2));
    expect(cleanupStaleSelfPreviewsMock).not.toHaveBeenCalled();
  });

  it("does nothing outside the 2 AM window", async () => {
    isFeatureEnabledMock.mockReturnValue(true);
    expect(await runDailyJobs(at(3))).toBe(false);
    expect(cleanupStaleSelfPreviewsMock).not.toHaveBeenCalled();
  });

  it("skips cleanupStaleSelfPreviews when previews are off", async () => {
    isFeatureEnabledMock.mockImplementation((flag: string) => flag === "selfManagement");
    await runDailyJobs(at(2));
    expect(cleanupStaleSelfPreviewsMock).not.toHaveBeenCalled();
  });

  it("runs once a day across restarts, from the persisted date", async () => {
    isFeatureEnabledMock.mockReturnValue(true);
    expect(await runDailyJobs(at(2))).toBe(true);
    expect(settings.get(DAILY_SCAN_DATE_KEY)).toBe(at(2).toDateString());

    // A fresh module stands in for a restarted or second process.
    vi.resetModules();
    const fresh = await import("@/lib/cron/scheduler");
    expect(await fresh.runDailyJobs(at(2))).toBe(false);
    expect(cleanupStaleSelfPreviewsMock).toHaveBeenCalledOnce();
  });
});
