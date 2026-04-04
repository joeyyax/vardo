import { seriesToPoints } from "./aggregate";
import { tsRedis, tsKey, ensureTimeSeries } from "./ts-client";
import { queryDiskHistory } from "./store-disk";
import type { MetricsPoint } from "./types";

export type TimeSeriesPoint = [number, number]; // [timestamp, value]

/**
 * Generic helper: ensure + write a set of named time-series values for a container.
 * Shared by storeMetrics, storeGpuMetrics, and any future per-container series.
 */
async function storeContainerSeries(
  projectName: string,
  containerId: string,
  containerName: string,
  timestamp: number,
  metrics: Record<string, number>,
  organizationId?: string | null,
) {
  const baseLabels: Record<string, string> = {
    project: projectName,
    container: containerId,
    containerName,
  };
  if (organizationId) baseLabels.organization = organizationId;

  const entries = Object.entries(metrics);
  const keys = entries.map(([name]) => tsKey(projectName, name, containerId));

  await Promise.all(
    entries.map(([name], i) => ensureTimeSeries(keys[i], { ...baseLabels, metric: name }))
  );

  const ts = timestamp.toString();
  await Promise.all(
    entries.map(([, value], i) => tsRedis.call("TS.ADD", keys[i], ts, value.toString()))
  );
}

/**
 * Store a metrics snapshot for a project's container.
 */
export async function storeMetrics(
  projectName: string,
  containerId: string,
  containerName: string,
  timestamp: number,
  values: {
    cpuPercent: number;
    memoryUsage: number;
    memoryLimit: number;
    networkRxBytes: number;
    networkTxBytes: number;
  },
  organizationId?: string | null,
) {
  await storeContainerSeries(projectName, containerId, containerName, timestamp, {
    cpu: values.cpuPercent,
    memory: values.memoryUsage,
    memoryLimit: values.memoryLimit,
    networkRx: values.networkRxBytes,
    networkTx: values.networkTxBytes,
  }, organizationId);
}

/**
 * Store cumulative disk write bytes for a container.
 */
export async function storeDiskWrite(
  projectName: string,
  containerId: string,
  containerName: string,
  timestamp: number,
  writeBytes: number,
  organizationId?: string | null,
) {
  const key = tsKey(projectName, "diskWrite", containerId);
  const labels: Record<string, string> = {
    project: projectName,
    container: containerId,
    containerName: containerName,
    metric: "diskWrite",
  };
  if (organizationId) labels.organization = organizationId;
  await ensureTimeSeries(key, labels);
  await tsRedis.call("TS.ADD", key, timestamp.toString(), writeBytes.toString());
}

/**
 * Store GPU metrics for a container (utilization, memory, temperature).
 * Only called when the container has accelerators reported by cAdvisor.
 */
export async function storeGpuMetrics(
  projectName: string,
  containerId: string,
  containerName: string,
  timestamp: number,
  values: {
    gpuUtilization: number;
    gpuMemoryUsed: number;
    gpuMemoryTotal: number;
    gpuTemperature: number;
  },
  organizationId?: string | null,
) {
  await storeContainerSeries(projectName, containerId, containerName, timestamp, {
    gpuUtilization: values.gpuUtilization,
    gpuMemoryUsed: values.gpuMemoryUsed,
    gpuMemoryTotal: values.gpuMemoryTotal,
    gpuTemperature: values.gpuTemperature,
  }, organizationId);
}

/**
 * Query disk write bytes for a specific container over a time range.
 * Returns raw [timestamp, value] pairs (cumulative counters).
 */
export async function queryDiskWriteRange(
  projectName: string,
  containerId: string,
  fromMs: number,
  toMs: number,
): Promise<TimeSeriesPoint[]> {
  const key = tsKey(projectName, "diskWrite", containerId);
  try {
    const result = (await tsRedis.call(
      "TS.RANGE", key, fromMs.toString(), toMs.toString(),
    )) as [string, string][];
    return result.map(([ts, val]) => [parseInt(ts), parseFloat(val)]);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

type MetricName = "cpu" | "memory" | "memoryLimit" | "networkRx" | "networkTx" | "disk" | "diskWrite" | "gpuUtilization" | "gpuMemoryUsed" | "gpuMemoryTotal" | "gpuTemperature";
type Aggregation = { type: "avg" | "max" | "min" | "sum"; bucketMs: number };

/**
 * Query historical metrics for a project.
 */
export async function queryMetrics(
  projectName: string,
  metric: MetricName,
  fromMs: number,
  toMs: number,
  aggregation?: Aggregation,
): Promise<TimeSeriesPoint[]> {
  return mrangeQuery(metric, fromMs, toMs, aggregation, [`project=${projectName}`]);
}

/**
 * Query historical metrics for an organization (all projects in the org).
 * Requires containers to have the `vardo.organization` label.
 */
export async function queryByOrg(
  orgId: string,
  metric: MetricName,
  fromMs: number,
  toMs: number,
  aggregation?: Aggregation,
): Promise<TimeSeriesPoint[]> {
  return mrangeQuery(metric, fromMs, toMs, aggregation, [`organization=${orgId}`]);
}

/**
 * Query historical metrics across all projects (system-wide).
 */
export async function queryAll(
  metric: MetricName,
  fromMs: number,
  toMs: number,
  aggregation?: Aggregation,
): Promise<TimeSeriesPoint[]> {
  return mrangeQuery(metric, fromMs, toMs, aggregation, []);
}

/**
 * Internal: run TS.MRANGE with filters and aggregate across series.
 */
function mrangeQuery(
  metric: MetricName,
  fromMs: number,
  toMs: number,
  aggregation: Aggregation | undefined,
  extraFilters: string[],
): Promise<TimeSeriesPoint[]> {
  return mrangeQueryImpl(metric, fromMs, toMs, aggregation, extraFilters);
}

async function mrangeQueryImpl(
  metric: MetricName,
  fromMs: number,
  toMs: number,
  aggregation: Aggregation | undefined,
  extraFilters: string[],
): Promise<TimeSeriesPoint[]> {
  const args: string[] = [fromMs.toString(), toMs.toString()];

  if (aggregation) {
    args.push("AGGREGATION", aggregation.type, aggregation.bucketMs.toString());
  }

  args.push("FILTER", `metric=${metric}`, ...extraFilters);

  let result: unknown[];
  try {
    result = (await tsRedis.call("TS.MRANGE", ...args)) as unknown[];
  } catch {
    return [];
  }

  if (!result || result.length === 0) return [];

  // Aggregate across series: max for limits, avg for GPU util/temp, sum otherwise
  const pointMap = new Map<number, number>();
  const useMax = metric === "memoryLimit" || metric === "disk";
  const useAvg = metric === "gpuUtilization" || metric === "gpuTemperature";
  const countMap = useAvg ? new Map<number, number>() : null;

  for (const series of result as [string, string[][], [string, string][]][]) {
    const dataPoints = series[2];
    for (const [ts, val] of dataPoints) {
      const t = parseInt(ts);
      const v = parseFloat(val);
      if (useMax) {
        pointMap.set(t, Math.max(pointMap.get(t) || 0, v));
      } else {
        pointMap.set(t, (pointMap.get(t) || 0) + v);
        if (countMap) countMap.set(t, (countMap.get(t) || 0) + 1);
      }
    }
  }

  return Array.from(pointMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => [t, countMap ? v / Math.max(1, countMap.get(t) ?? 1) : v] as TimeSeriesPoint);
}

// ---------------------------------------------------------------------------
// Unified MetricsPoint[] query helpers
// ---------------------------------------------------------------------------

/** Query historical metrics for a project, returns unified MetricsPoint[] */
export async function queryMetricsPoints(
  projectName: string,
  fromMs: number,
  toMs: number,
  bucketMs: number,
  includeGpu = false,
): Promise<MetricsPoint[]> {
  const [cpu, memory, memoryLimit, networkRx, networkTx, gpuUtilization, gpuMemoryUsed, gpuMemoryTotal, gpuTemperature] = await Promise.all([
    queryMetrics(projectName, "cpu", fromMs, toMs, { type: "avg", bucketMs }),
    queryMetrics(projectName, "memory", fromMs, toMs, { type: "avg", bucketMs }),
    queryMetrics(projectName, "memoryLimit", fromMs, toMs, { type: "max", bucketMs }),
    queryMetrics(projectName, "networkRx", fromMs, toMs, { type: "sum", bucketMs }),
    queryMetrics(projectName, "networkTx", fromMs, toMs, { type: "sum", bucketMs }),
    ...(includeGpu ? [
      queryMetrics(projectName, "gpuUtilization", fromMs, toMs, { type: "avg", bucketMs }),
      queryMetrics(projectName, "gpuMemoryUsed", fromMs, toMs, { type: "avg", bucketMs }),
      queryMetrics(projectName, "gpuMemoryTotal", fromMs, toMs, { type: "max", bucketMs }),
      queryMetrics(projectName, "gpuTemperature", fromMs, toMs, { type: "avg", bucketMs }),
    ] : []),
  ]);

  if (!includeGpu) {
    return seriesToPoints({ cpu, memory, memoryLimit, networkRx, networkTx });
  }
  return seriesToPoints({ cpu, memory, memoryLimit, networkRx, networkTx, gpuUtilization, gpuMemoryUsed, gpuMemoryTotal, gpuTemperature });
}

/** Query historical metrics for an org, returns unified MetricsPoint[] */
export async function queryByOrgPoints(
  orgId: string,
  fromMs: number,
  toMs: number,
  bucketMs: number,
  includeGpu = false,
): Promise<MetricsPoint[]> {
  const [cpu, memory, memoryLimit, networkRx, networkTx, gpuUtilization, gpuMemoryUsed, gpuMemoryTotal, gpuTemperature] = await Promise.all([
    queryByOrg(orgId, "cpu", fromMs, toMs, { type: "avg", bucketMs }),
    queryByOrg(orgId, "memory", fromMs, toMs, { type: "avg", bucketMs }),
    queryByOrg(orgId, "memoryLimit", fromMs, toMs, { type: "max", bucketMs }),
    queryByOrg(orgId, "networkRx", fromMs, toMs, { type: "sum", bucketMs }),
    queryByOrg(orgId, "networkTx", fromMs, toMs, { type: "sum", bucketMs }),
    ...(includeGpu ? [
      queryByOrg(orgId, "gpuUtilization", fromMs, toMs, { type: "avg", bucketMs }),
      queryByOrg(orgId, "gpuMemoryUsed", fromMs, toMs, { type: "avg", bucketMs }),
      queryByOrg(orgId, "gpuMemoryTotal", fromMs, toMs, { type: "max", bucketMs }),
      queryByOrg(orgId, "gpuTemperature", fromMs, toMs, { type: "avg", bucketMs }),
    ] : []),
  ]);

  if (!includeGpu) {
    return seriesToPoints({ cpu, memory, memoryLimit, networkRx, networkTx });
  }
  return seriesToPoints({ cpu, memory, memoryLimit, networkRx, networkTx, gpuUtilization, gpuMemoryUsed, gpuMemoryTotal, gpuTemperature });
}

/** Query historical metrics system-wide, returns unified MetricsPoint[] */
export async function queryAllPoints(
  fromMs: number,
  toMs: number,
  bucketMs: number,
  includeGpu = false,
): Promise<MetricsPoint[]> {
  const [cpu, memory, memoryLimit, networkRx, networkTx, disk, gpuUtilization, gpuMemoryUsed, gpuMemoryTotal, gpuTemperature] = await Promise.all([
    queryAll("cpu", fromMs, toMs, { type: "avg", bucketMs }),
    queryAll("memory", fromMs, toMs, { type: "avg", bucketMs }),
    queryAll("memoryLimit", fromMs, toMs, { type: "max", bucketMs }),
    queryAll("networkRx", fromMs, toMs, { type: "sum", bucketMs }),
    queryAll("networkTx", fromMs, toMs, { type: "sum", bucketMs }),
    queryDiskHistory(fromMs, toMs, bucketMs),
    ...(includeGpu ? [
      queryAll("gpuUtilization", fromMs, toMs, { type: "avg", bucketMs }),
      queryAll("gpuMemoryUsed", fromMs, toMs, { type: "avg", bucketMs }),
      queryAll("gpuMemoryTotal", fromMs, toMs, { type: "max", bucketMs }),
      queryAll("gpuTemperature", fromMs, toMs, { type: "avg", bucketMs }),
    ] : []),
  ]);

  if (!includeGpu) {
    return seriesToPoints({ cpu, memory, memoryLimit, networkRx, networkTx, disk });
  }
  return seriesToPoints({ cpu, memory, memoryLimit, networkRx, networkTx, disk, gpuUtilization, gpuMemoryUsed, gpuMemoryTotal, gpuTemperature });
}
