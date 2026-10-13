import { seriesToPoints } from "./aggregate";
import { tsRedis, tsKey, ensureTimeSeries, touchRetention, forgetKey, RETENTION_MS } from "./ts-client";
import { queryDiskHistory } from "./store-disk";
import type { MetricsPoint } from "./types";

export type TimeSeriesPoint = [number, number]; // [timestamp, value]

/** Ensures and writes a set of named time-series values for a container. */
async function storeContainerSeries(
  projectName: string,
  containerId: string,
  containerName: string,
  timestamp: number,
  metrics: Record<string, number>,
  organizationId?: string | null,
  composeService?: string | null,
) {
  const baseLabels: Record<string, string> = {
    project: projectName,
    container: containerId,
    containerName,
  };
  if (organizationId) baseLabels.organization = organizationId;
  if (composeService) baseLabels.service = composeService;

  const entries = Object.entries(metrics);
  const keys = entries.map(([name]) => tsKey(projectName, name, containerId));

  await Promise.all(
    entries.map(([name], i) => ensureTimeSeries(keys[i], { ...baseLabels, metric: name }))
  );

  const ts = timestamp.toString();
  await Promise.all(
    entries.map(async ([, value], i) => {
      await tsRedis.call("TS.ADD", keys[i], ts, value.toString(), "ON_DUPLICATE", "LAST");
      await touchRetention(keys[i]);
    })
  );
}

/** Stores a metrics snapshot for a project's container. */
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
  composeService?: string | null,
) {
  await storeContainerSeries(projectName, containerId, containerName, timestamp, {
    cpu: values.cpuPercent,
    memory: values.memoryUsage,
    memoryLimit: values.memoryLimit,
    networkRx: values.networkRxBytes,
    networkTx: values.networkTxBytes,
  }, organizationId, composeService);
}

/** Stores cumulative disk write bytes for a container. */
export async function storeDiskWrite(
  projectName: string,
  containerId: string,
  containerName: string,
  timestamp: number,
  writeBytes: number,
  organizationId?: string | null,
  composeService?: string | null,
) {
  const key = tsKey(projectName, "diskWrite", containerId);
  const labels: Record<string, string> = {
    project: projectName,
    container: containerId,
    containerName: containerName,
    metric: "diskWrite",
  };
  if (organizationId) labels.organization = organizationId;
  if (composeService) labels.service = composeService;
  await ensureTimeSeries(key, labels);
  await tsRedis.call("TS.ADD", key, timestamp.toString(), writeBytes.toString(), "ON_DUPLICATE", "LAST");
  await touchRetention(key);
}

/** Stores GPU metrics for a container with accelerators. */
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
  composeService?: string | null,
) {
  await storeContainerSeries(projectName, containerId, containerName, timestamp, {
    gpuUtilization: values.gpuUtilization,
    gpuMemoryUsed: values.gpuMemoryUsed,
    gpuMemoryTotal: values.gpuMemoryTotal,
    gpuTemperature: values.gpuTemperature,
  }, organizationId, composeService);
}

const GPU_METRIC_NAMES = ["gpuUtilization", "gpuMemoryUsed", "gpuMemoryTotal", "gpuTemperature"] as const;

/** Deletes GPU series older than retention. Returns the number of containers pruned. */
export async function pruneStaleGpuSeries(): Promise<number> {
  const now = Date.now();
  let pruned = 0;
  let cursor = "0";

  do {
    const [next, keys] = (await tsRedis.call(
      "SCAN", cursor, "MATCH", "metrics:*:gpuUtilization:*", "COUNT", "200",
    )) as [string, string[]];
    cursor = next;

    for (const key of keys) {
      // metrics:{project}:{metric}:{container}. Split from the end; project may contain ':'.
      const parts = key.split(":");
      const containerId = parts[parts.length - 1];
      const projectName = parts.slice(1, parts.length - 2).join(":");
      if (!containerId || !projectName) continue;

      try {
        const last = (await tsRedis.call("TS.GET", key)) as [string, string] | null;
        if (last && now - parseInt(last[0], 10) <= RETENTION_MS) continue;

        await Promise.all(
          GPU_METRIC_NAMES.map(async (metric) => {
            const gpuKey = tsKey(projectName, metric, containerId);
            await tsRedis.call("DEL", gpuKey).catch(() => {});
            forgetKey(gpuKey);
          }),
        );
        pruned++;
      } catch {
        // Best-effort; the next sweep retries.
      }
    }
  } while (cursor !== "0");

  return pruned;
}

/** Cumulative disk write bytes for a container over a time range. */
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

type MetricName = "cpu" | "memory" | "memoryLimit" | "networkRx" | "networkTx" | "disk" | "diskWrite" | "gpuUtilization" | "gpuMemoryUsed" | "gpuMemoryTotal" | "gpuTemperature";
type Aggregation = { type: "avg" | "max" | "min" | "sum" | "last"; bucketMs: number };

/** Historical metrics for a project. `composeService` narrows a stack to one service. */
export async function queryMetrics(
  projectName: string,
  metric: MetricName,
  fromMs: number,
  toMs: number,
  aggregation?: Aggregation,
  composeService?: string | null,
): Promise<TimeSeriesPoint[]> {
  const filters = [`project=${projectName}`];
  if (composeService) filters.push(`service=${composeService}`);
  return mrangeQuery(metric, fromMs, toMs, aggregation, filters);
}

/** Historical metrics for an organization. Requires the `vardo.organization` label. */
export async function queryByOrg(
  orgId: string,
  metric: MetricName,
  fromMs: number,
  toMs: number,
  aggregation?: Aggregation,
): Promise<TimeSeriesPoint[]> {
  return mrangeQuery(metric, fromMs, toMs, aggregation, [`organization=${orgId}`]);
}

/** Historical metrics across all projects. */
export async function queryAll(
  metric: MetricName,
  fromMs: number,
  toMs: number,
  aggregation?: Aggregation,
): Promise<TimeSeriesPoint[]> {
  return mrangeQuery(metric, fromMs, toMs, aggregation, []);
}

/** Runs TS.MRANGE with filters and aggregates across series. */
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

  return combineSeries(
    metric,
    (result as [string, string[][], [string, string][]][]).map((series) =>
      series[2].map(([ts, val]) => [parseInt(ts), parseFloat(val)] as TimeSeriesPoint),
    ),
    aggregation?.bucketMs,
  );
}

/** Gauges hold their last reading across empty buckets; counter deltas don't. */
const GAUGES = new Set<MetricName>(["cpu", "memory", "memoryLimit", "disk", "gpuUtilization", "gpuMemoryUsed", "gpuMemoryTotal", "gpuTemperature"]);

/** A carried reading older than this counts as gone. */
const CARRY_LIMIT_MS = 90_000;

/** Merges per-container series into one: max for limits, avg for GPU util/temp, sum otherwise. */
export function combineSeries(metric: MetricName, seriesList: TimeSeriesPoint[][], bucketMs?: number): TimeSeriesPoint[] {
  const useMax = metric === "memoryLimit" || metric === "disk";
  const useAvg = metric === "gpuUtilization" || metric === "gpuTemperature";
  const carry = GAUGES.has(metric) ? Math.max(CARRY_LIMIT_MS, (bucketMs ?? 0) * 3) : 0;
  const times = [...new Set(seriesList.flatMap((points) => points.map(([t]) => t)))].sort((a, b) => a - b);

  const total = new Map<number, number>();
  const count = new Map<number, number>();
  for (const points of seriesList) {
    if (points.length === 0) continue;
    const sorted = [...points].sort((a, b) => a[0] - b[0]);
    const last = sorted[sorted.length - 1][0];
    let k = 0;
    let held: TimeSeriesPoint | null = null;
    for (const t of times) {
      if (t < sorted[0][0]) continue;
      // A container that stopped reporting drops out after its last reading.
      if (t > last && t - last > carry) break;
      while (k < sorted.length && sorted[k][0] <= t) held = sorted[k++];
      if (!held) continue;
      if (held[0] !== t && t - held[0] > carry) continue;
      const v = held[1];
      total.set(t, useMax ? Math.max(total.get(t) ?? 0, v) : (total.get(t) ?? 0) + v);
      count.set(t, (count.get(t) ?? 0) + 1);
    }
  }

  return times
    .filter((t) => total.has(t))
    .map((t) => [t, useAvg ? total.get(t)! / Math.max(1, count.get(t) ?? 1) : total.get(t)!] as TimeSeriesPoint);
}

/** Historical metrics for a project as MetricsPoint[]. `composeService` narrows a stack to one service. */
export async function queryMetricsPoints(
  projectName: string,
  fromMs: number,
  toMs: number,
  bucketMs: number,
  includeGpu = false,
  composeService?: string | null,
): Promise<MetricsPoint[]> {
  const [cpu, memory, memoryLimit, networkRx, networkTx, disk, gpuUtilization, gpuMemoryUsed, gpuMemoryTotal, gpuTemperature] = await Promise.all([
    queryMetrics(projectName, "cpu", fromMs, toMs, { type: "avg", bucketMs }, composeService),
    queryMetrics(projectName, "memory", fromMs, toMs, { type: "avg", bucketMs }, composeService),
    queryMetrics(projectName, "memoryLimit", fromMs, toMs, { type: "max", bucketMs }, composeService),
    queryMetrics(projectName, "networkRx", fromMs, toMs, { type: "last", bucketMs }, composeService),
    queryMetrics(projectName, "networkTx", fromMs, toMs, { type: "last", bucketMs }, composeService),
    queryMetrics(projectName, "disk", fromMs, toMs, { type: "max", bucketMs }, composeService),
    ...(includeGpu ? [
      queryMetrics(projectName, "gpuUtilization", fromMs, toMs, { type: "avg", bucketMs }, composeService),
      queryMetrics(projectName, "gpuMemoryUsed", fromMs, toMs, { type: "avg", bucketMs }, composeService),
      queryMetrics(projectName, "gpuMemoryTotal", fromMs, toMs, { type: "max", bucketMs }, composeService),
      queryMetrics(projectName, "gpuTemperature", fromMs, toMs, { type: "avg", bucketMs }, composeService),
    ] : []),
  ]);

  if (!includeGpu) {
    return seriesToPoints({ cpu, memory, memoryLimit, networkRx, networkTx, disk });
  }
  return seriesToPoints({ cpu, memory, memoryLimit, networkRx, networkTx, disk, gpuUtilization, gpuMemoryUsed, gpuMemoryTotal, gpuTemperature });
}

/** Historical metrics for an org as MetricsPoint[]. */
export async function queryByOrgPoints(
  orgId: string,
  fromMs: number,
  toMs: number,
  bucketMs: number,
  includeGpu = false,
): Promise<MetricsPoint[]> {
  const [cpu, memory, memoryLimit, networkRx, networkTx, disk, gpuUtilization, gpuMemoryUsed, gpuMemoryTotal, gpuTemperature] = await Promise.all([
    queryByOrg(orgId, "cpu", fromMs, toMs, { type: "avg", bucketMs }),
    queryByOrg(orgId, "memory", fromMs, toMs, { type: "avg", bucketMs }),
    queryByOrg(orgId, "memoryLimit", fromMs, toMs, { type: "max", bucketMs }),
    queryByOrg(orgId, "networkRx", fromMs, toMs, { type: "last", bucketMs }),
    queryByOrg(orgId, "networkTx", fromMs, toMs, { type: "last", bucketMs }),
    queryByOrg(orgId, "disk", fromMs, toMs, { type: "max", bucketMs }),
    ...(includeGpu ? [
      queryByOrg(orgId, "gpuUtilization", fromMs, toMs, { type: "avg", bucketMs }),
      queryByOrg(orgId, "gpuMemoryUsed", fromMs, toMs, { type: "avg", bucketMs }),
      queryByOrg(orgId, "gpuMemoryTotal", fromMs, toMs, { type: "max", bucketMs }),
      queryByOrg(orgId, "gpuTemperature", fromMs, toMs, { type: "avg", bucketMs }),
    ] : []),
  ]);

  if (!includeGpu) {
    return seriesToPoints({ cpu, memory, memoryLimit, networkRx, networkTx, disk });
  }
  return seriesToPoints({ cpu, memory, memoryLimit, networkRx, networkTx, disk, gpuUtilization, gpuMemoryUsed, gpuMemoryTotal, gpuTemperature });
}

/** Historical metrics system-wide as MetricsPoint[]. */
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
    queryAll("networkRx", fromMs, toMs, { type: "last", bucketMs }),
    queryAll("networkTx", fromMs, toMs, { type: "last", bucketMs }),
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
