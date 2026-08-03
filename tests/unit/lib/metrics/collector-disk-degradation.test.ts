import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ContainerMetrics } from "@/lib/metrics/types";

// ---------------------------------------------------------------------------
// Hoisted mock state — vi.mock is hoisted so factories must use vi.hoisted()
// ---------------------------------------------------------------------------

const { logMock, dockerMock, storeMock, providerMock, businessMock } = vi.hoisted(() => {
  const logMock = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const dockerMock = {
    getSystemDiskUsage: vi.fn(),
    getPerProjectDiskUsage: vi.fn(),
  };
  const storeMock = {
    storeMetrics: vi.fn().mockResolvedValue(undefined),
    storeDiskUsage: vi.fn().mockResolvedValue(undefined),
    storeDiskWrite: vi.fn().mockResolvedValue(undefined),
    storeGpuMetrics: vi.fn().mockResolvedValue(undefined),
    storeProjectDisk: vi.fn().mockResolvedValue(undefined),
  };
  const providerMock = { fetchAllMetrics: vi.fn().mockResolvedValue([]) };
  const businessMock = { collectBusinessMetrics: vi.fn().mockResolvedValue(undefined) };
  return { logMock, dockerMock, storeMock, providerMock, businessMock };
});

vi.mock("@/lib/logger", () => ({ logger: { child: () => logMock } }));
vi.mock("@/lib/docker/client", () => dockerMock);
vi.mock("@/lib/metrics/store", () => storeMock);
vi.mock("@/lib/metrics/provider", () => providerMock);
vi.mock("@/lib/metrics/collect-business-metrics", () => businessMock);
vi.mock("@/lib/metrics/disk-write-alerts", () => ({
  checkDiskWriteAlerts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/gpu/collector", () => ({
  initGpuCollector: vi.fn().mockResolvedValue(null),
  getGpuCollector: vi.fn().mockReturnValue(null),
  setGpuSnapshot: vi.fn(),
  getGpuSnapshot: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/metrics/config", () => ({
  isMetricsEnabled: vi.fn().mockReturnValue(true),
  initMetricsProvider: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { startCollector, stopCollector, shouldLogPersistentFailure } from "@/lib/metrics/collector";

// The exact 404 seen in production: containerd has a dangling snapshot
// reference, so Docker's /system/df blows up entirely.
const SNAPSHOT_404 = new Error(
  "Docker API GET /system/df returned 404: failed to calculate image disk usage: " +
    "NotFound: snapshot ad06a6c3f2e1... does not exist: not found",
);

function sampleMetric(): ContainerMetrics {
  return {
    containerId: "abc123",
    containerIdFull: "",
    containerName: "web",
    projectName: "demo",
    organizationId: "org-1",
    labels: {},
    cpuPercent: 1,
    memoryUsage: 100,
    memoryLimit: 200,
    memoryPercent: 50,
    networkRxBytes: 0,
    networkTxBytes: 0,
    diskUsage: 0,
    diskLimit: 0,
    diskWriteBytes: 0,
    gpuUtilization: 0,
    gpuMemoryUsed: 0,
    gpuMemoryTotal: 0,
    gpuTemperature: 0,
    timestamp: Date.now(),
  };
}

/** Advance the fake clock and flush the pending collect() tick. */
async function tick(ms = 5000) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("collector disk-usage degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    providerMock.fetchAllMetrics.mockResolvedValue([sampleMetric()]);
    dockerMock.getSystemDiskUsage.mockResolvedValue({
      images: { count: 0, totalSize: 0, reclaimable: 0 },
      containers: { count: 0, totalSize: 0 },
      volumes: { count: 0, totalSize: 0 },
      buildCache: { count: 0, totalSize: 0, reclaimable: 0 },
      total: 0,
    });
    dockerMock.getPerProjectDiskUsage.mockResolvedValue(new Map());
  });

  afterEach(() => {
    stopCollector();
    vi.useRealTimers();
  });

  it("does not store zero and keeps other collection running when /system/df 404s", async () => {
    dockerMock.getSystemDiskUsage.mockRejectedValue(SNAPSHOT_404);

    await startCollector();
    await tick(); // tickCount 0 — first disk-check cycle

    expect(storeMock.storeDiskUsage).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Disk error"),
      expect.stringContaining("NotFound: snapshot"),
    );

    // Everything else the collector gathers keeps working.
    expect(storeMock.storeMetrics).toHaveBeenCalled();
    expect(businessMock.collectBusinessMetrics).toHaveBeenCalled();
  });

  it("does not store zero and keeps other collection running when per-project disk 404s", async () => {
    dockerMock.getPerProjectDiskUsage.mockRejectedValue(SNAPSHOT_404);

    await startCollector();
    await tick();

    expect(storeMock.storeProjectDisk).not.toHaveBeenCalled();
    expect(storeMock.storeDiskUsage).toHaveBeenCalled(); // system disk still succeeded
    expect(logMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Per-project disk error"),
      expect.stringContaining("NotFound: snapshot"),
    );
  });

  it("logs a persistent 404 once, then stays quiet on the very next cycle", async () => {
    dockerMock.getSystemDiskUsage.mockRejectedValue(SNAPSHOT_404);
    dockerMock.getPerProjectDiskUsage.mockRejectedValue(SNAPSHOT_404);

    await startCollector();
    await tick(); // tickCount 0 — 1st disk-check cycle, 1st failure — logs

    const errorsAfterFirstFailure = logMock.error.mock.calls.length;
    expect(errorsAfterFirstFailure).toBeGreaterThan(0);

    // tickCount 1, 2, 3 don't run a disk check (interval is 4 during warmup);
    // tickCount 4 is the 2nd disk-check cycle — 2nd consecutive failure.
    await tick();
    await tick();
    await tick();
    await tick();

    // Rate-limited: the 2nd consecutive failure does not add new error logs.
    expect(logMock.error.mock.calls.length).toBe(errorsAfterFirstFailure);
  });

  it("logs recovery and re-arms logging for the next failure", async () => {
    dockerMock.getSystemDiskUsage.mockRejectedValueOnce(SNAPSHOT_404);

    await startCollector();
    await tick(); // fails once — logged

    expect(storeMock.storeDiskUsage).not.toHaveBeenCalled();
    const errorsAfterFailure = logMock.error.mock.calls.length;

    // Docker recovers (dangling snapshot cleared) — next disk-check cycle succeeds.
    await tick();
    await tick();
    await tick();
    await tick(); // tickCount 4 — 2nd disk-check cycle, now resolves

    expect(storeMock.storeDiskUsage).toHaveBeenCalled();
    expect(logMock.info).toHaveBeenCalledWith(
      expect.stringContaining("Disk usage recovered after 1 failed collection(s)"),
    );

    // A fresh failure right after recovery logs immediately (count reset to 1),
    // proving the rate limit doesn't get stuck suppressed forever.
    dockerMock.getSystemDiskUsage.mockRejectedValue(SNAPSHOT_404);
    await tick();
    await tick();
    await tick();
    await tick(); // tickCount 8 — 3rd disk-check cycle, fails again

    expect(logMock.error.mock.calls.length).toBeGreaterThan(errorsAfterFailure);
  });
});

describe("collector single tick loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    providerMock.fetchAllMetrics.mockResolvedValue([sampleMetric()]);
    dockerMock.getSystemDiskUsage.mockRejectedValue(SNAPSHOT_404);
    dockerMock.getPerProjectDiskUsage.mockRejectedValue(SNAPSHOT_404);
  });

  afterEach(() => {
    stopCollector();
    vi.useRealTimers();
    vi.resetModules();
  });

  // Next.js bundles instrumentation and route handlers separately, so the module
  // gets loaded twice in one process and each copy tried to start its own loop.
  it("does not start a second loop when another module instance starts it", async () => {
    await startCollector();

    vi.resetModules();
    const secondInstance = await import("@/lib/metrics/collector");
    expect(secondInstance.startCollector).not.toBe(startCollector); // genuinely a second copy
    await secondInstance.startCollector();

    const startLogs = logMock.info.mock.calls.filter(([msg]) =>
      String(msg).includes("Starting metrics collection"),
    );
    expect(startLogs).toHaveLength(1);
    expect(secondInstance.isCollectorRunning()).toBe(true);

    await tick();
    expect(providerMock.fetchAllMetrics).toHaveBeenCalledTimes(1);
  });
});

describe("shouldLogPersistentFailure", () => {
  it("logs the first occurrence", () => {
    expect(shouldLogPersistentFailure(1)).toBe(true);
  });

  it("stays quiet in between", () => {
    expect(shouldLogPersistentFailure(2)).toBe(false);
    expect(shouldLogPersistentFailure(19)).toBe(false);
  });

  it("re-logs at the default reduced rate (every 20th)", () => {
    expect(shouldLogPersistentFailure(20)).toBe(true);
    expect(shouldLogPersistentFailure(21)).toBe(false);
    expect(shouldLogPersistentFailure(40)).toBe(true);
  });

  it("honors a custom rate", () => {
    expect(shouldLogPersistentFailure(5, 5)).toBe(true);
    expect(shouldLogPersistentFailure(4, 5)).toBe(false);
  });
});
