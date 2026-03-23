import Redis from "ioredis";
import { seriesToPoints } from "./aggregate";
import type { MetricsPoint } from "./types";

const url = process.env.REDIS_URL || "redis://localhost:9200";

// Dedicated connection for time-series operations
const globalForTS = globalThis as unknown as { tsRedis: Redis | undefined };
const tsRedis = globalForTS.tsRedis ?? new Redis(url, { maxRetriesPerRequest: 3 });
if (process.env.NODE_ENV !== "production") globalForTS.tsRedis = tsRedis;

// Retention: 7 days in ms
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Key naming: metrics:{projectName}:{metric}:{containerId}
function tsKey(project: string, metric: string, container?: string) {
  return container
    ? `metrics:${project}:${metric}:${container}`
    : `metrics:${project}:${metric}`;
}

// Track which time-series keys have already been created to skip redundant TS.CREATE calls
const createdKeys = new Set<string>();

/**
 * Ensure a time-series key exists with the correct retention and labels.
 * Skips the TS.CREATE call if the key was already created in this process.
 */
async function ensureTimeSeries(
  key: string,
  labels: Record<string, string>
) {
  if (createdKeys.has(key)) return;

  try {
    const labelArgs = Object.entries(labels).flat();
    await tsRedis.call(
      "TS.CREATE",
      key,
      "RETENTION",
      RETENTION_MS.toString(),
      "DUPLICATE_POLICY",
      "LAST",
      "LABELS",
      ...labelArgs
    );
  } catch (err: unknown) {
    // Key already exists — that's fine
    if (err instanceof Error && !err.message.includes("already exists")) {
      throw err;
    }
  }

  createdKeys.add(key);
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
  const labels: Record<string, string> = {
    project: projectName,
    container: containerId,
    containerName: containerName,
  };
  if (organizationId) labels.organization = organizationId;

  const keys = {
    cpu: tsKey(projectName, "cpu", containerId),
    memory: tsKey(projectName, "memory", containerId),
    memoryLimit: tsKey(projectName, "memoryLimit", containerId),
    networkRx: tsKey(projectName, "networkRx", containerId),
    networkTx: tsKey(projectName, "networkTx", containerId),
  };

  // Ensure all keys exist
  await Promise.all([
    ensureTimeSeries(keys.cpu, { ...labels, metric: "cpu" }),
    ensureTimeSeries(keys.memory, { ...labels, metric: "memory" }),
    ensureTimeSeries(keys.memoryLimit, { ...labels, metric: "memoryLimit" }),
    ensureTimeSeries(keys.networkRx, { ...labels, metric: "networkRx" }),
    ensureTimeSeries(keys.networkTx, { ...labels, metric: "networkTx" }),
  ]);

  // Add data points
  const ts = timestamp.toString();
  await Promise.all([
    tsRedis.call("TS.ADD", keys.cpu, ts, values.cpuPercent.toString()),
    tsRedis.call("TS.ADD", keys.memory, ts, values.memoryUsage.toString()),
    tsRedis.call("TS.ADD", keys.memoryLimit, ts, values.memoryLimit.toString()),
    tsRedis.call("TS.ADD", keys.networkRx, ts, values.networkRxBytes.toString()),
    tsRedis.call("TS.ADD", keys.networkTx, ts, values.networkTxBytes.toString()),
  ]);
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

/**
 * Store system-level disk usage (not per-project).
 */
export async function storeDiskUsage(
  timestamp: number,
  values: { images: number; volumes: number; buildCache: number; total: number }
) {
  const labels = { scope: "system", metric: "disk" };

  const keys = {
    total: "metrics:system:diskTotal",
    images: "metrics:system:diskImages",
    volumes: "metrics:system:diskVolumes",
    buildCache: "metrics:system:diskBuildCache",
  };

  await Promise.all([
    ensureTimeSeries(keys.total, { ...labels, type: "total" }),
    ensureTimeSeries(keys.images, { ...labels, type: "images" }),
    ensureTimeSeries(keys.volumes, { ...labels, type: "volumes" }),
    ensureTimeSeries(keys.buildCache, { ...labels, type: "buildCache" }),
  ]);

  const ts = timestamp.toString();
  await Promise.all([
    tsRedis.call("TS.ADD", keys.total, ts, values.total.toString()),
    tsRedis.call("TS.ADD", keys.images, ts, values.images.toString()),
    tsRedis.call("TS.ADD", keys.volumes, ts, values.volumes.toString()),
    tsRedis.call("TS.ADD", keys.buildCache, ts, values.buildCache.toString()),
  ]);
}

/**
 * Query system-level disk usage history.
 */
export async function queryDiskHistory(
  fromMs: number,
  toMs: number,
  bucketMs = 30000
): Promise<TimeSeriesPoint[]> {
  const key = "metrics:system:diskTotal";
  try {
    const result = (await tsRedis.call(
      "TS.RANGE", key, fromMs.toString(), toMs.toString(),
      "AGGREGATION", "avg", bucketMs.toString()
    )) as [string, string][];
    return result.map(([ts, val]) => [parseInt(ts), parseFloat(val)]);
  } catch {
    return [];
  }
}

/**
 * Get the latest disk usage values from Redis (instant, no Docker call).
 */
export async function getLatestDiskUsage(): Promise<{
  total: number;
  images: number;
  volumes: number;
  buildCache: number;
} | null> {
  try {
    const [total, images, volumes, buildCache] = await Promise.all([
      tsRedis.call("TS.GET", "metrics:system:diskTotal") as Promise<[string, string] | null>,
      tsRedis.call("TS.GET", "metrics:system:diskImages") as Promise<[string, string] | null>,
      tsRedis.call("TS.GET", "metrics:system:diskVolumes") as Promise<[string, string] | null>,
      tsRedis.call("TS.GET", "metrics:system:diskBuildCache") as Promise<[string, string] | null>,
    ]);
    if (!total) return null;
    return {
      total: parseFloat(total[1]),
      images: images ? parseFloat(images[1]) : 0,
      volumes: volumes ? parseFloat(volumes[1]) : 0,
      buildCache: buildCache ? parseFloat(buildCache[1]) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Store per-project disk usage.
 */
export async function storeProjectDisk(
  projectName: string,
  timestamp: number,
  sizeBytes: number
) {
  const key = tsKey(projectName, "disk");
  await ensureTimeSeries(key, { project: projectName, metric: "disk" });
  await tsRedis.call("TS.ADD", key, timestamp.toString(), sizeBytes.toString());
}

/**
 * Get the latest disk usage for a specific project from Redis (no Docker call).
 */
export async function getLatestProjectDiskUsage(
  projectName: string
): Promise<number | null> {
  try {
    const key = tsKey(projectName, "disk");
    const result = (await tsRedis.call("TS.GET", key)) as [string, string] | null;
    if (!result) return null;
    return parseFloat(result[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Business metrics (entity counts)
// ---------------------------------------------------------------------------

export type BusinessMetricName =
  | "users"
  | "organizations"
  | "projects"
  | "apps"
  | "deployments"
  | "domains"
  | "backups"
  | "cronJobs"
  | "templates";

/**
 * Store a business metric snapshot (entity count).
 */
export async function storeBusinessMetric(
  metric: BusinessMetricName,
  timestamp: number,
  value: number,
) {
  const key = `metrics:business:${metric}`;
  await ensureTimeSeries(key, { scope: "business", metric });
  await tsRedis.call("TS.ADD", key, timestamp.toString(), value.toString());
}

/**
 * Query historical business metrics.
 */
export async function queryBusinessMetric(
  metric: BusinessMetricName,
  fromMs: number,
  toMs: number,
  bucketMs = 300_000, // 5 min default
): Promise<TimeSeriesPoint[]> {
  const key = `metrics:business:${metric}`;
  try {
    const result = (await tsRedis.call(
      "TS.RANGE", key, fromMs.toString(), toMs.toString(),
      "AGGREGATION", "last", bucketMs.toString(),
    )) as [string, string][];
    return result.map(([ts, val]) => [parseInt(ts), parseFloat(val)]);
  } catch {
    return [];
  }
}

/**
 * Get the latest value for a business metric.
 */
export async function getLatestBusinessMetric(
  metric: BusinessMetricName,
): Promise<{ timestamp: number; value: number } | null> {
  try {
    const key = `metrics:business:${metric}`;
    const result = (await tsRedis.call("TS.GET", key)) as [string, string] | null;
    if (!result) return null;
    return { timestamp: parseInt(result[0]), value: parseFloat(result[1]) };
  } catch {
    return null;
  }
}

export type TimeSeriesPoint = [number, number]; // [timestamp, value]

/**
 * Query historical metrics for a project.
 * Returns data points within the given time range.
 */
type MetricName = "cpu" | "memory" | "memoryLimit" | "networkRx" | "networkTx" | "disk" | "diskWrite";
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
 * Requires containers to have the `host.organization` label.
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

  // Aggregate across series by summing (or max for limits)
  const pointMap = new Map<number, number>();
  const useMax = metric === "memoryLimit" || metric === "disk";

  for (const series of result as [string, string[][], [string, string][]][]) {
    const dataPoints = series[2];
    for (const [ts, val] of dataPoints) {
      const t = parseInt(ts);
      const v = parseFloat(val);
      if (useMax) {
        pointMap.set(t, Math.max(pointMap.get(t) || 0, v));
      } else {
        pointMap.set(t, (pointMap.get(t) || 0) + v);
      }
    }
  }

  return Array.from(pointMap.entries()).sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------------------
// Per-org business metrics
// ---------------------------------------------------------------------------

/**
 * Store a per-org business metric snapshot.
 */
export async function storeOrgBusinessMetric(
  orgId: string,
  metric: BusinessMetricName,
  timestamp: number,
  value: number,
) {
  const key = `metrics:business:${orgId}:${metric}`;
  await ensureTimeSeries(key, { scope: "business", organization: orgId, metric });
  await tsRedis.call("TS.ADD", key, timestamp.toString(), value.toString());
}

/**
 * Query historical per-org business metrics.
 */
export async function queryOrgBusinessMetric(
  orgId: string,
  metric: BusinessMetricName,
  fromMs: number,
  toMs: number,
  bucketMs = 300_000,
): Promise<TimeSeriesPoint[]> {
  const key = `metrics:business:${orgId}:${metric}`;
  try {
    const result = (await tsRedis.call(
      "TS.RANGE", key, fromMs.toString(), toMs.toString(),
      "AGGREGATION", "last", bucketMs.toString(),
    )) as [string, string][];
    return result.map(([ts, val]) => [parseInt(ts), parseFloat(val)]);
  } catch {
    return [];
  }
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
): Promise<MetricsPoint[]> {
  const [cpu, memory, memoryLimit, networkRx, networkTx] = await Promise.all([
    queryMetrics(projectName, "cpu", fromMs, toMs, { type: "avg", bucketMs }),
    queryMetrics(projectName, "memory", fromMs, toMs, { type: "avg", bucketMs }),
    queryMetrics(projectName, "memoryLimit", fromMs, toMs, {
      type: "max",
      bucketMs,
    }),
    queryMetrics(projectName, "networkRx", fromMs, toMs, {
      type: "sum",
      bucketMs,
    }),
    queryMetrics(projectName, "networkTx", fromMs, toMs, {
      type: "sum",
      bucketMs,
    }),
  ]);
  return seriesToPoints({ cpu, memory, memoryLimit, networkRx, networkTx });
}

/** Query historical metrics for an org, returns unified MetricsPoint[] */
export async function queryByOrgPoints(
  orgId: string,
  fromMs: number,
  toMs: number,
  bucketMs: number,
): Promise<MetricsPoint[]> {
  const [cpu, memory, memoryLimit, networkRx, networkTx] = await Promise.all([
    queryByOrg(orgId, "cpu", fromMs, toMs, { type: "avg", bucketMs }),
    queryByOrg(orgId, "memory", fromMs, toMs, { type: "avg", bucketMs }),
    queryByOrg(orgId, "memoryLimit", fromMs, toMs, { type: "max", bucketMs }),
    queryByOrg(orgId, "networkRx", fromMs, toMs, { type: "sum", bucketMs }),
    queryByOrg(orgId, "networkTx", fromMs, toMs, { type: "sum", bucketMs }),
  ]);
  return seriesToPoints({ cpu, memory, memoryLimit, networkRx, networkTx });
}

/** Query historical metrics system-wide, returns unified MetricsPoint[] */
export async function queryAllPoints(
  fromMs: number,
  toMs: number,
  bucketMs: number,
): Promise<MetricsPoint[]> {
  const [cpu, memory, memoryLimit, networkRx, networkTx, disk] =
    await Promise.all([
      queryAll("cpu", fromMs, toMs, { type: "avg", bucketMs }),
      queryAll("memory", fromMs, toMs, { type: "avg", bucketMs }),
      queryAll("memoryLimit", fromMs, toMs, { type: "max", bucketMs }),
      queryAll("networkRx", fromMs, toMs, { type: "sum", bucketMs }),
      queryAll("networkTx", fromMs, toMs, { type: "sum", bucketMs }),
      queryDiskHistory(fromMs, toMs, bucketMs),
    ]);
  return seriesToPoints({
    cpu,
    memory,
    memoryLimit,
    networkRx,
    networkTx,
    disk,
  });
}
