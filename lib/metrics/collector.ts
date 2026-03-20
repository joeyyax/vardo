import { fetchAllContainerMetrics } from "./cadvisor";
import { storeMetrics, storeDiskUsage } from "./store";
import { getSystemDiskUsage } from "@/lib/docker/client";

let interval: ReturnType<typeof setInterval> | null = null;
let started = false;

/**
 * Start the metrics collector.
 * Polls cAdvisor every 30s and stores results in Redis TimeSeries.
 */
export function isCollectorRunning() {
  return started;
}

export function startCollector(intervalMs = 30000) {
  if (started) return; // Already running
  started = true;
  console.log("[collector] Starting metrics collection every", intervalMs, "ms");

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

    // Also collect disk usage
    try {
      const diskUsage = await getSystemDiskUsage();
      await storeDiskUsage(Date.now(), {
        images: diskUsage.images.totalSize,
        volumes: diskUsage.volumes.totalSize,
        buildCache: diskUsage.buildCache.totalSize,
        total: diskUsage.total,
      });
    } catch (err) {
      console.error("[collector] Disk error:", (err as Error).message);
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
