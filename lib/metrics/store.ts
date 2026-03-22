import Redis from "ioredis";

const url = process.env.REDIS_URL || "redis://localhost:6379";

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
  }
) {
  const labels = {
    project: projectName,
    container: containerId,
    containerName: containerName,
  };

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

export type TimeSeriesPoint = [number, number]; // [timestamp, value]

/**
 * Query historical metrics for a project.
 * Returns data points within the given time range.
 */
export async function queryMetrics(
  projectName: string,
  metric: "cpu" | "memory" | "memoryLimit" | "networkRx" | "networkTx",
  fromMs: number,
  toMs: number,
  aggregation?: { type: "avg" | "max" | "min" | "sum"; bucketMs: number }
): Promise<TimeSeriesPoint[]> {
  // Find all keys for this project + metric
  const keys = (await tsRedis.call(
    "TS.QUERYINDEX",
    `project=${projectName}`,
    `metric=${metric}`
  )) as string[];

  if (!keys || keys.length === 0) return [];

  // For aggregated queries across multiple containers, use TS.MRANGE
  const args: string[] = [
    fromMs.toString(),
    toMs.toString(),
  ];

  if (aggregation) {
    args.push("AGGREGATION", aggregation.type, aggregation.bucketMs.toString());
  }

  args.push("FILTER", `project=${projectName}`, `metric=${metric}`);

  const result = (await tsRedis.call("TS.MRANGE", ...args)) as unknown[];

  // Parse TS.MRANGE result: [[key, labels, [[ts, val], ...]], ...]
  // Aggregate across containers by summing at each timestamp
  const pointMap = new Map<number, number>();

  for (const series of result as [string, string[][], [string, string][]][]) {
    const dataPoints = series[2];
    for (const [ts, val] of dataPoints) {
      const t = parseInt(ts);
      const v = parseFloat(val);
      if (metric === "cpu" || metric === "memory" || metric === "networkRx" || metric === "networkTx") {
        pointMap.set(t, (pointMap.get(t) || 0) + v);
      } else {
        // For limits, take the max
        pointMap.set(t, Math.max(pointMap.get(t) || 0, v));
      }
    }
  }

  return Array.from(pointMap.entries()).sort((a, b) => a[0] - b[0]);
}
