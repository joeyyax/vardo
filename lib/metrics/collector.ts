import { fetchAllContainerMetrics } from "./cadvisor";
import { storeMetrics, storeDiskUsage, storeProjectDisk } from "./store";
import { getSystemDiskUsage, getPerProjectDiskUsage } from "@/lib/docker/client";

let timeout: ReturnType<typeof setTimeout> | null = null;
let started = false;
let tickCount = 0;

const FAST_INTERVAL_MS = 5000;   // First 20 ticks: every 5s
const NORMAL_INTERVAL_MS = 30000; // After warmup: every 30s
const WARMUP_TICKS = 20;

/**
 * Start the metrics collector.
 * Starts fast (every 5s for the first 20 ticks) then settles to every 30s.
 */
export function isCollectorRunning() {
  return started;
}

export function startCollector() {
  if (started) return;
  started = true;
  tickCount = 0;
  console.log("[collector] Starting metrics collection (fast warmup: 5s × 20, then 30s)");
  scheduleTick();
}

function scheduleTick() {
  if (!started) return;
  const interval = tickCount < WARMUP_TICKS ? FAST_INTERVAL_MS : NORMAL_INTERVAL_MS;
  timeout = setTimeout(async () => {
    await collect();
    tickCount++;
    scheduleTick();
  }, interval);
}

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
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      console.error(`[collector] ${results.length - failed} stored, ${failed} failed:`, (results.find((r) => r.status === "rejected") as PromiseRejectedResult)?.reason);
    }
  } catch (err) {
    console.error("[collector] Error:", (err as Error).message);
  }

  // Disk usage: every 10th tick during warmup, every 10th tick after (~5 min at 30s)
  const diskInterval = tickCount < WARMUP_TICKS ? 4 : 10; // Every 20s during warmup, every 5min after
  if (tickCount % diskInterval === 0) {
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

    try {
      const perProject = await getPerProjectDiskUsage();
      const ts = Date.now();
      await Promise.allSettled(
        Array.from(perProject.entries()).map(([name, size]) =>
          storeProjectDisk(name, ts, size)
        )
      );
    } catch (err) {
      console.error("[collector] Per-project disk error:", (err as Error).message);
    }
  }
}

// Collect immediately on start
collect();

export function stopCollector() {
  if (timeout) {
    clearTimeout(timeout);
    timeout = null;
  }
  started = false;
}
