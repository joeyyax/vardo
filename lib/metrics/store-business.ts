import { tsRedis, ensureTimeSeries } from "./ts-client";
import type { TimeSeriesPoint } from "./store-container";

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
