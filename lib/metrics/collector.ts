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
      await Promise.allSettled(
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
    } catch {
      // cAdvisor may not be running — silently skip
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
