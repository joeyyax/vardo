import { describe, expect, it, beforeEach } from "vitest";
import { getLatestSnapshot, setLatestSnapshot } from "@/lib/metrics/broadcast";
import type { ContainerMetrics } from "@/lib/metrics/types";

function sample(memoryUsage: number): ContainerMetrics {
  return {
    containerId: "abc",
    containerName: "web",
    projectName: "demo",
    organizationId: "org",
    timestamp: 0,
    cpuPercent: 1,
    memoryUsage,
    memoryLimit: 100,
    networkRxBytes: 0,
    networkTxBytes: 0,
    diskWriteBytes: 0,
    gpuUtilization: 0,
    gpuMemoryUsed: 0,
    gpuMemoryTotal: 0,
    gpuTemperature: 0,
  } as ContainerMetrics;
}

describe("the snapshot the admin overview reads", () => {
  beforeEach(() => setLatestSnapshot([]));

  it("is filled by the collector, not only by an open metrics stream", () => {
    setLatestSnapshot([sample(512)]);
    expect(getLatestSnapshot()).toHaveLength(1);
    expect(getLatestSnapshot()?.[0].memoryUsage).toBe(512);
  });

  it("replaces rather than accumulates, so a gone container drops out", () => {
    setLatestSnapshot([sample(512)]);
    setLatestSnapshot([]);
    expect(getLatestSnapshot()).toHaveLength(0);
  });
});
