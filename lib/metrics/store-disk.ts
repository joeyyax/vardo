import { tsRedis, tsKey, ensureTimeSeries } from "./ts-client";
import type { TimeSeriesPoint } from "./store-container";

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
