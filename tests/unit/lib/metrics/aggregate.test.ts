import { describe, it, expect } from "vitest";
import { aggregateContainers, dedupeByContainer } from "@/lib/metrics/aggregate";
import type { ContainerMetrics, ContainerPoint } from "@/lib/metrics/types";

// ---------------------------------------------------------------------------
// aggregateContainers — GPU metric aggregation
// ---------------------------------------------------------------------------
// GPU utilization and temperature are averaged across GPU-enabled containers
// (those with gpuMemoryTotal > 0). Memory values are summed.

function makeContainer(overrides: Partial<ContainerMetrics> = {}): ContainerMetrics {
  return {
    containerId: "abc123",
    containerIdFull: "abc123",
    containerName: "test",
    projectName: "myapp",
    organizationId: null,
    labels: {},
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

// ---------------------------------------------------------------------------
// dedupeByContainer — fleet totals built from per-app breakdowns
// ---------------------------------------------------------------------------

function point(overrides: Partial<ContainerPoint> = {}): ContainerPoint {
  return {
    containerId: "c1",
    containerName: "container",
    composeService: null,
    cpuPercent: 0,
    memoryUsage: 0,
    memoryLimit: 0,
    memoryPercent: 0,
    networkRx: 0,
    networkTx: 0,
    gpuUtilization: 0,
    gpuMemoryUsed: 0,
    gpuMemoryTotal: 0,
    gpuTemperature: 0,
    ...overrides,
  };
}

describe("dedupeByContainer", () => {
  const server = point({ containerId: "c-server", composeService: "server", memoryUsage: 512_000_000 });
  const db = point({ containerId: "c-db", composeService: "db", memoryUsage: 80_000_000 });
  const standalone = point({ containerId: "c-solo", memoryUsage: 40_000_000 });

  // Breakdown as the stream sends it: the parent stack, one row per compose
  // child, then an unrelated single-container app.
  const perApp = [[server, db], [server], [db], [standalone]];

  it("counts each container once across overlapping app breakdowns", () => {
    const unique = dedupeByContainer(perApp);

    expect(unique.map((c) => c.containerId).sort()).toEqual(["c-db", "c-server", "c-solo"]);
    expect(unique.reduce((s, c) => s + c.memoryUsage, 0)).toBe(632_000_000);
  });

  it("keeps a stack's containers out of the total twice", () => {
    const flat = perApp.flat().reduce((s, c) => s + c.memoryUsage, 0);
    const deduped = dedupeByContainer(perApp).reduce((s, c) => s + c.memoryUsage, 0);

    expect(flat).toBe(1_224_000_000);
    expect(deduped).toBe(632_000_000);
  });

  it("returns an empty list when no app has containers", () => {
    expect(dedupeByContainer([[], []])).toEqual([]);
  });
});
