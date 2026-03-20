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

/**
 * Ensure a time-series key exists with the correct retention and labels.
 * Uses TS.CREATE with IGNORE_DUPLICATE_KEY if already exists.
 */
async function ensureTimeSeries(
  key: string,
  labels: Record<string, string>
) {
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
