import { tsRedis } from "./ts-client";

/** How old the newest sample can be and still describe the fleet now. */
const FRESH_WINDOW_MS = 5 * 60 * 1000;

export type FleetTotals = {
  /** Summed container CPU percent across the fleet. */
  cpuPercent: number;
  /** Summed container memory in bytes. */
  memoryBytes: number;
};

/**
 * Sum the last sample of every series for a metric.
 *
 * TS.MGET, not TS.MRANGE: containers write on their own schedules, so the
 * newest range bucket holds whichever few happened to land on that millisecond
 * — summing it reported the whole fleet at one container's usage. MGET takes
 * each series' own latest point.
 *
 * Returns null when nothing is fresh, so a fleet that isn't being measured
 * doesn't read as a fleet using nothing.
 */
async function sumLatest(metric: string, cutoffMs: number): Promise<number | null> {
  let result: unknown;
  try {
    result = await tsRedis.call("TS.MGET", "FILTER", `metric=${metric}`);
  } catch {
    return null;
  }

  if (!Array.isArray(result) || result.length === 0) return null;

  let total = 0;
  let fresh = 0;
  for (const series of result as [string, unknown[], [string, string]][]) {
    const point = series?.[2];
    if (!Array.isArray(point) || point.length < 2) continue;
    const ts = Number(point[0]);
    const value = Number(point[1]);
    if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
    if (ts < cutoffMs) continue;
    total += value;
    fresh++;
  }

  return fresh > 0 ? total : null;
}

/**
 * Fleet CPU and memory from the time-series store.
 *
 * Reads the shared store rather than the broadcast module's in-process
 * snapshot: that variable is only filled while something is subscribed, and a
 * server component does not share a module instance with the collector.
 */
export async function getFleetTotals(now = Date.now()): Promise<FleetTotals | null> {
  const cutoff = now - FRESH_WINDOW_MS;

  const [cpuPercent, memoryBytes] = await Promise.all([
    sumLatest("cpu", cutoff),
    sumLatest("memory", cutoff),
  ]);

  if (cpuPercent === null && memoryBytes === null) return null;
  return { cpuPercent: cpuPercent ?? 0, memoryBytes: memoryBytes ?? 0 };
}
