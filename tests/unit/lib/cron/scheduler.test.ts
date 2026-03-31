import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const { isFeatureEnabledMock, cleanupStaleSelfPreviewsMock, tickCronJobsMock } = vi.hoisted(() => {
  return {
    isFeatureEnabledMock: vi.fn().mockReturnValue(false),
    cleanupStaleSelfPreviewsMock: vi.fn().mockResolvedValue(0),
    tickCronJobsMock: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/config/features", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

vi.mock("@/lib/docker/self-preview", () => ({
  cleanupStaleSelfPreviews: cleanupStaleSelfPreviewsMock,
}));

vi.mock("@/lib/cron/engine", () => ({
  tickCronJobs: tickCronJobsMock,
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

vi.mock("@/lib/db/schema", () => ({
  organizations: {},
}));

vi.mock("@/lib/security/scanner", () => ({
  runScheduledScans: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { startCronScheduler, stopCronScheduler } from "@/lib/cron/scheduler";

// ---------------------------------------------------------------------------
// selfManagement feature gate
// ---------------------------------------------------------------------------

describe("selfManagement feature gate in daily scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set system clock to 2:00 AM so the hourly interval fires the daily job.
    const twoAM = new Date();
    twoAM.setHours(2, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(twoAM);
  });

  afterEach(() => {
    stopCronScheduler();
    vi.useRealTimers();
  });

  it("calls cleanupStaleSelfPreviews when selfManagement is enabled", async () => {
    isFeatureEnabledMock.mockReturnValue(true);

    startCronScheduler();
    // Advance one full hour to trigger the daily interval callback
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(cleanupStaleSelfPreviewsMock).toHaveBeenCalledOnce();
  });

  it("skips cleanupStaleSelfPreviews when selfManagement is disabled", async () => {
    isFeatureEnabledMock.mockReturnValue(false);

    startCronScheduler();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(cleanupStaleSelfPreviewsMock).not.toHaveBeenCalled();
  });

  it("does not call cleanupStaleSelfPreviews outside the 2 AM window", async () => {
    isFeatureEnabledMock.mockReturnValue(true);

    // Set time to 3 AM — outside the fire window
    const threeAM = new Date();
    threeAM.setHours(3, 0, 0, 0);
    vi.setSystemTime(threeAM);

    startCronScheduler();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(cleanupStaleSelfPreviewsMock).not.toHaveBeenCalled();
  });
});
