// UPS readings over time in Redis TimeSeries, kept as long as other metrics.

import { forgetKey, ensureTimeSeries, tsRedis } from "@/lib/metrics/ts-client";
import type { UpsReading } from "./status";

export const UPS_METRICS = ["charge", "runtime", "load", "realpower", "inputVoltage"] as const;
export type UpsMetric = (typeof UPS_METRICS)[number];

/** metrics:system:ups:{serverId}:{metric}. The system namespace is outside the orphan sweep. */
export function upsKey(serverId: string, metric: UpsMetric): string {
  return `metrics:system:ups:${serverId}:${metric}`;
}

export async function storeUpsSample(serverId: string, timestamp: number, reading: UpsReading): Promise<void> {
  const ts = timestamp.toString();
  await Promise.all(
    UPS_METRICS.map(async (metric) => {
      const value = reading[metric];
      if (value === null || !Number.isFinite(value)) return;
      const key = upsKey(serverId, metric);
      await ensureTimeSeries(key, { scope: "system", metric: "ups", ups: serverId, type: metric });
      await tsRedis.call("TS.ADD", key, ts, value.toString(), "ON_DUPLICATE", "LAST");
    }),
  );
}

export type UpsHistoryPoint = { at: number } & Partial<Record<UpsMetric, number>>;

/** Each metric averaged per bucket, merged by time, oldest first. */
export async function queryUpsHistory(serverId: string, fromMs: number, toMs: number, bucketMs: number): Promise<UpsHistoryPoint[]> {
  const rows = new Map<number, UpsHistoryPoint>();
  await Promise.all(
    UPS_METRICS.map(async (metric) => {
      let result: [string, string][] = [];
      try {
        result = (await tsRedis.call(
          "TS.RANGE", upsKey(serverId, metric), fromMs.toString(), toMs.toString(),
          "AGGREGATION", "avg", bucketMs.toString(),
        )) as [string, string][];
      } catch {
        return;
      }
      for (const [ts, val] of result) {
        const at = parseInt(ts);
        const row = rows.get(at) ?? { at };
        row[metric] = Math.round(parseFloat(val) * 10) / 10;
        rows.set(at, row);
      }
    }),
  );
  return [...rows.values()].sort((a, b) => a.at - b.at);
}

export async function deleteUpsHistory(serverId: string): Promise<void> {
  const keys = UPS_METRICS.map((m) => upsKey(serverId, m));
  await tsRedis.del(...keys).catch(() => 0);
  for (const key of keys) forgetKey(key);
}
