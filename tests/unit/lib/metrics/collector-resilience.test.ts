import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state — vi.mock is hoisted so factories must use vi.hoisted()
// ---------------------------------------------------------------------------

const { logMock, dockerMock, storeMock, providerMock, businessMock } = vi.hoisted(() => {
  const logMock = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const dockerMock = {
    getDiskSnapshot: vi.fn(),
  };
  const storeMock = {
    storeMetrics: vi.fn().mockResolvedValue(undefined),
    storeDiskUsage: vi.fn().mockResolvedValue(undefined),
    storeDiskWrite: vi.fn().mockResolvedValue(undefined),
    storeGpuMetrics: vi.fn().mockResolvedValue(undefined),
    storeProjectDisk: vi.fn().mockResolvedValue(undefined),
    pruneStaleGpuSeries: vi.fn().mockResolvedValue(0),
  };
  const providerMock = { fetchAllMetrics: vi.fn().mockResolvedValue([]), metricsPollIntervalMs: () => 5000 };
  const businessMock = { collectBusinessMetrics: vi.fn().mockResolvedValue(undefined) };
  return { logMock, dockerMock, storeMock, providerMock, businessMock };
});

vi.mock("@/lib/logger", () => ({ logger: { child: () => logMock } }));
vi.mock("@/lib/docker/disk-snapshot", () => dockerMock);
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
  isMetricsLoopEnabled: vi.fn().mockReturnValue(true),
  initMetricsProvider: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { startCollector, stopCollector, isCollectorRunning } from "@/lib/metrics/collector";
import { MetricsNotReadyError } from "@/lib/metrics/not-ready";


const DISK = {
  usage: {
    images: { count: 0, totalSize: 0, reclaimable: 0 },
    containers: { count: 0, totalSize: 0 },
    volumes: { count: 0, totalSize: 0 },
    buildCache: { count: 0, totalSize: 0, reclaimable: 0 },
    total: 0,
  },
  perProject: new Map(),
};

describe("metrics loop without a fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    dockerMock.getDiskSnapshot.mockResolvedValue(DISK);
  });

  afterEach(() => {
    stopCollector();
    vi.useRealTimers();
  });

  it("keeps polling through a long outage, at most 2 minutes apart", async () => {
    providerMock.fetchAllMetrics.mockRejectedValue(new Error("collector unreachable"));
    await startCollector();
    await vi.advanceTimersByTimeAsync(5000);
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(providerMock.fetchAllMetrics.mock.calls.length).toBeGreaterThan(40);
    expect(isCollectorRunning()).toBe(true);
    // Disk usage and business metrics don't wait on the collector.
    expect(storeMock.storeDiskUsage).toHaveBeenCalled();
    expect(businessMock.collectBusinessMetrics).toHaveBeenCalled();
  });

  it("treats a cold collector as a skipped tick, not a failure", async () => {
    providerMock.fetchAllMetrics.mockRejectedValue(new MetricsNotReadyError("collector has no rates yet"));
    await startCollector();
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(5000);

    // Warmup cadence holds: no backoff.
    expect(providerMock.fetchAllMetrics).toHaveBeenCalledTimes(5);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
