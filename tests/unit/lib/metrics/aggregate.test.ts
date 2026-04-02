import { describe, it, expect } from "vitest";
import { aggregateContainers } from "@/lib/metrics/aggregate";
import type { ContainerMetrics } from "@/lib/metrics/types";

// ---------------------------------------------------------------------------
// aggregateContainers — GPU metric aggregation
// ---------------------------------------------------------------------------
// GPU utilization and temperature are averaged across GPU-enabled containers
// (those with gpuMemoryTotal > 0). Memory values are summed.

function makeContainer(overrides: Partial<ContainerMetrics> = {}): ContainerMetrics {
  return {
    containerId: "abc123",
    containerName: "test",
    projectName: "myapp",
    organizationId: null,
    cpuPercent: 0,
    memoryUsage: 0,
    memoryLimit: 0,
    memoryPercent: 0,
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
    ...overrides,
  };
}

describe("aggregateContainers — GPU averaging", () => {
  it("averages gpuUtilization across GPU containers", () => {
    const containers = [
      makeContainer({ gpuMemoryTotal: 8_000_000_000, gpuUtilization: 40 }),
      makeContainer({ gpuMemoryTotal: 8_000_000_000, gpuUtilization: 80 }),
    ];
    const result = aggregateContainers(containers);
    expect(result.gpuUtilization).toBe(60);
  });

  it("averages gpuTemperature across GPU containers", () => {
    const containers = [
      makeContainer({ gpuMemoryTotal: 8_000_000_000, gpuTemperature: 60 }),
      makeContainer({ gpuMemoryTotal: 8_000_000_000, gpuTemperature: 80 }),
    ];
    const result = aggregateContainers(containers);
    expect(result.gpuTemperature).toBe(70);
  });

  it("sums gpuMemoryUsed across all containers", () => {
    const containers = [
      makeContainer({ gpuMemoryTotal: 8_000_000_000, gpuMemoryUsed: 1_000_000_000 }),
      makeContainer({ gpuMemoryTotal: 8_000_000_000, gpuMemoryUsed: 3_000_000_000 }),
    ];
    const result = aggregateContainers(containers);
    expect(result.gpuMemoryUsed).toBe(4_000_000_000);
  });

  it("sums gpuMemoryTotal across all containers", () => {
    const containers = [
      makeContainer({ gpuMemoryTotal: 8_000_000_000 }),
      makeContainer({ gpuMemoryTotal: 8_000_000_000 }),
    ];
    const result = aggregateContainers(containers);
    expect(result.gpuMemoryTotal).toBe(16_000_000_000);
  });

  it("excludes non-GPU containers from utilization average", () => {
    // One GPU container at 60%, one non-GPU container (gpuMemoryTotal=0) — average should be 60, not 30
    const containers = [
      makeContainer({ gpuMemoryTotal: 8_000_000_000, gpuUtilization: 60 }),
      makeContainer({ gpuMemoryTotal: 0, gpuUtilization: 0 }),
    ];
    const result = aggregateContainers(containers);
    expect(result.gpuUtilization).toBe(60);
  });

  it("excludes non-GPU containers from temperature average", () => {
    const containers = [
      makeContainer({ gpuMemoryTotal: 8_000_000_000, gpuTemperature: 70 }),
      makeContainer({ gpuMemoryTotal: 0, gpuTemperature: 0 }),
    ];
    const result = aggregateContainers(containers);
    expect(result.gpuTemperature).toBe(70);
  });

  it("returns zero GPU values when no containers have GPU", () => {
    const containers = [
      makeContainer({ cpuPercent: 10 }),
      makeContainer({ cpuPercent: 20 }),
    ];
    const result = aggregateContainers(containers);
    expect(result.gpuUtilization).toBe(0);
    expect(result.gpuMemoryUsed).toBe(0);
    expect(result.gpuMemoryTotal).toBe(0);
    expect(result.gpuTemperature).toBe(0);
  });

  it("returns zero GPU values for an empty container list", () => {
    const result = aggregateContainers([]);
    expect(result.gpuUtilization).toBe(0);
    expect(result.gpuMemoryUsed).toBe(0);
    expect(result.gpuMemoryTotal).toBe(0);
    expect(result.gpuTemperature).toBe(0);
  });

  it("rounds gpuUtilization to two decimal places", () => {
    const containers = [
      makeContainer({ gpuMemoryTotal: 8_000_000_000, gpuUtilization: 33.333 }),
      makeContainer({ gpuMemoryTotal: 8_000_000_000, gpuUtilization: 66.667 }),
    ];
    const result = aggregateContainers(containers);
    // (33.333 + 66.667) / 2 = 50
    expect(result.gpuUtilization).toBe(50);
  });

  it("rounds gpuTemperature to the nearest integer", () => {
    const containers = [
      makeContainer({ gpuMemoryTotal: 8_000_000_000, gpuTemperature: 65 }),
      makeContainer({ gpuMemoryTotal: 8_000_000_000, gpuTemperature: 66 }),
    ];
    const result = aggregateContainers(containers);
    // Math.round((65 + 66) / 2) = Math.round(65.5) = 66
    expect(result.gpuTemperature).toBe(66);
  });
});
