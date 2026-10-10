import { tsRedis, ensureTimeSeries } from "./ts-client";
import type { TimeSeriesPoint } from "./store-container";

export type HostMetric = "memory" | "swap" | "cpu" | "load" | "disk";

const KEYS: Record<HostMetric, string> = {
  memory: "metrics:system:hostMemory",
  swap: "metrics:system:hostSwap",
  cpu: "metrics:system:hostCpu",
  load: "metrics:system:hostLoad",
  disk: "metrics:system:hostDisk",
};

/** Host readings in percent, load as a multiple of cores. Missing readings are skipped. */
export async function storeHostSample(timestamp: number, values: Partial<Record<HostMetric, number | null>>): Promise<void> {
  const ts = timestamp.toString();
  await Promise.all(
    (Object.entries(values) as [HostMetric, number | null | undefined][]).map(async ([metric, value]) => {
      if (value === null || value === undefined || !Number.isFinite(value)) return;
      await ensureTimeSeries(KEYS[metric], { scope: "system", metric: "host", type: metric });
      await tsRedis.call("TS.ADD", KEYS[metric], ts, value.toString(), "ON_DUPLICATE", "LAST");
    }),
  );
}

/** Averages per bucket, oldest first. Empty when the series is missing. */
export async function queryHostHistory(metric: HostMetric, fromMs: number, toMs: number, bucketMs: number): Promise<TimeSeriesPoint[]> {
  try {
    const result = (await tsRedis.call(
      "TS.RANGE", KEYS[metric], fromMs.toString(), toMs.toString(),
      "AGGREGATION", "avg", bucketMs.toString(),
    )) as [string, string][];
    return result.map(([ts, val]) => [parseInt(ts), parseFloat(val)]);
  } catch {
    return [];
  }
}
