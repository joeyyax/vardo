import { queryAll } from "./store-container";

/** How far back a sample can be and still describe the fleet right now. */
const FRESH_WINDOW_MS = 5 * 60 * 1000;

export type FleetTotals = {
  /** Summed container CPU percent across the fleet. */
  cpuPercent: number;
  /** Summed container memory in bytes. */
  memoryBytes: number;
};

/** The most recent value in a series, or null when nothing landed in the window. */
function latest(points: [number, number][]): number | null {
  if (points.length === 0) return null;
  return points[points.length - 1][1];
}

/**
 * Fleet CPU and memory from the time-series store.
 *
 * Reads the shared store rather than the broadcast module's in-process
 * snapshot: that variable is only filled while something is subscribed, and a
 * server component does not share a module instance with the collector.
 *
 * Returns null when no sample landed recently, so callers can say "not
 * measured" instead of reporting an empty fleet as zero usage.
 */
export async function getFleetTotals(now = Date.now()): Promise<FleetTotals | null> {
  const from = now - FRESH_WINDOW_MS;

  const series = async (metric: "cpu" | "memory"): Promise<[number, number][]> => {
    try {
      return await queryAll(metric, from, now);
    } catch {
      return [];
    }
  };

  const [cpu, memory] = await Promise.all([series("cpu"), series("memory")]);

  const cpuPercent = latest(cpu);
  const memoryBytes = latest(memory);
  if (cpuPercent === null && memoryBytes === null) return null;

  return { cpuPercent: cpuPercent ?? 0, memoryBytes: memoryBytes ?? 0 };
}
