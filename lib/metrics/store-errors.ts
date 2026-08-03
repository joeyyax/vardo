import { tsRedis, ensureTimeSeries, touchRetention } from "./ts-client";

/**
 * Log line counts per app: matches for the error shape, and the total they came
 * out of. Keyed on app id rather than project name so a rename does not orphan
 * the series and a stack child never collides with its parent.
 */
function key(appId: string, metric: "errors" | "lines"): string {
  return `metrics:logs:${appId}:${metric}`;
}

export async function storeLogCounts(
  appId: string,
  timestamp: number,
  counts: { errors: number; lines: number },
  organizationId?: string | null,
): Promise<void> {
  const ts = timestamp.toString();

  await Promise.all(
    (["errors", "lines"] as const).map(async (metric) => {
      const labels: Record<string, string> = { scope: "logs", app: appId, metric: `log${metric}` };
      if (organizationId) labels.organization = organizationId;
      const k = key(appId, metric);
      await ensureTimeSeries(k, labels);
      await tsRedis.call("TS.ADD", k, ts, String(counts[metric]));
      await touchRetention(k);
    }),
  );
}

export type LogCountSample = { at: number; errors: number; lines: number };

/**
 * Samples in a range, paired by timestamp. Never reads a last value: retention
 * only trims on write, so an idle series would otherwise report a stale rate
 * as the current one forever.
 */
export async function queryLogCounts(
  appId: string,
  fromMs: number,
  toMs: number,
): Promise<LogCountSample[]> {
  const [errors, lines] = await Promise.all([
    range(key(appId, "errors"), fromMs, toMs),
    range(key(appId, "lines"), fromMs, toMs),
  ]);

  return [...errors.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, count]) => ({ at, errors: count, lines: lines.get(at) ?? 0 }));
}

async function range(k: string, fromMs: number, toMs: number): Promise<Map<number, number>> {
  try {
    const result = (await tsRedis.call("TS.RANGE", k, fromMs.toString(), toMs.toString())) as
      | [string, string][]
      | null;
    return new Map((result ?? []).map(([ts, val]) => [parseInt(ts, 10), parseFloat(val)]));
  } catch {
    return new Map();
  }
}
