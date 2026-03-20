import { fetchAllContainerMetrics } from "./cadvisor";
import { storeMetrics } from "./store";

let interval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the metrics collector.
 * Polls cAdvisor every 30s and stores results in Redis TimeSeries.
 */
export function startCollector(intervalMs = 30000) {
  if (interval) return; // Already running

  async function collect() {
    try {
      const metrics = await fetchAllContainerMetrics();
      const results = await Promise.allSettled(
        metrics.map((m) =>
          storeMetrics(m.projectName, m.containerId, m.containerName, m.timestamp, {
            cpuPercent: m.cpuPercent,
            memoryUsage: m.memoryUsage,
            memoryLimit: m.memoryLimit,
            networkRxBytes: m.networkRxBytes,
            networkTxBytes: m.networkTxBytes,
          })
        )
      );
      const stored = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        console.error(`[collector] Stored ${stored}, failed ${failed}:`, (results.find((r) => r.status === "rejected") as PromiseRejectedResult)?.reason);
      }
    } catch (err) {
      console.error("[collector] Error:", (err as Error).message);
    }
  }

  // Collect immediately, then on interval
  collect();
  interval = setInterval(collect, intervalMs);
}

export function stopCollector() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
