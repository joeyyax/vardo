import type { ContainerMetrics } from "./cadvisor";
import type { MetricsPoint, ContainerPoint } from "./types";

/** Aggregate container metrics into a single MetricsPoint */
export function aggregateContainers(
  containers: ContainerMetrics[],
  diskTotal = 0,
): MetricsPoint {
  return {
    timestamp: Date.now(),
    cpu:
      Math.round(
        containers.reduce((s, c) => s + c.cpuPercent, 0) * 100,
      ) / 100,
    memory: containers.reduce((s, c) => s + c.memoryUsage, 0),
    memoryLimit: Math.max(0, ...containers.map((c) => c.memoryLimit)),
    networkRx: containers.reduce((s, c) => s + c.networkRxBytes, 0),
    networkTx: containers.reduce((s, c) => s + c.networkTxBytes, 0),
    diskTotal,
  };
}

/** Convert a ContainerMetrics to the client-facing ContainerPoint shape */
export function containerToPoint(m: ContainerMetrics): ContainerPoint {
  return {
    containerId: m.containerId,
    containerName: m.containerName,
    cpuPercent: m.cpuPercent,
    memoryUsage: m.memoryUsage,
    memoryLimit: m.memoryLimit,
    memoryPercent: m.memoryPercent,
    networkRx: m.networkRxBytes,
    networkTx: m.networkTxBytes,
  };
}

/**
 * Convert parallel Redis TS series arrays into MetricsPoint[].
 * Each series is [[timestamp, value], ...] sorted by timestamp.
 */
export function seriesToPoints(series: {
  cpu?: [number, number][];
  memory?: [number, number][];
  memoryLimit?: [number, number][];
  networkRx?: [number, number][];
  networkTx?: [number, number][];
  disk?: [number, number][];
}): MetricsPoint[] {
  // Collect all unique timestamps
  const tsSet = new Set<number>();
  for (const arr of Object.values(series)) {
    if (arr) for (const [ts] of arr) tsSet.add(ts);
  }

  const timestamps = Array.from(tsSet).sort((a, b) => a - b);

  // Build lookup maps for each series
  const cpuMap = new Map(series.cpu || []);
  const memMap = new Map(series.memory || []);
  const memLimitMap = new Map(series.memoryLimit || []);
  const rxMap = new Map(series.networkRx || []);
  const txMap = new Map(series.networkTx || []);
  const diskMap = new Map(series.disk || []);

  return timestamps.map((ts) => ({
    timestamp: ts,
    cpu: Math.round((cpuMap.get(ts) || 0) * 100) / 100,
    memory: memMap.get(ts) || 0,
    memoryLimit: memLimitMap.get(ts) || 0,
    networkRx: rxMap.get(ts) || 0,
    networkTx: txMap.get(ts) || 0,
    diskTotal: diskMap.get(ts) || 0,
  }));
}
