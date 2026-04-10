import { logger } from "@/lib/logger";
import { isMetricsEnabled, initMetricsProvider } from "./config";
import { fetchAllMetrics } from "./provider";
import { storeMetrics, storeDiskUsage, storeDiskWrite, storeGpuMetrics, storeProjectDisk } from "./store";
import { checkDiskWriteAlerts } from "./disk-write-alerts";
import { getSystemDiskUsage, getPerProjectDiskUsage } from "@/lib/docker/client";
import { collectBusinessMetrics } from "./collect-business-metrics";
import { initGpuCollector, getGpuCollector, setGpuSnapshot } from "@/lib/gpu/collector";

const log = logger.child("collector");

let timeout: ReturnType<typeof setTimeout> | null = null;
let started = false;
let tickCount = 0;
let consecutiveFailures = 0;
const DEGRADED_THRESHOLD = 3; // mark integration degraded after 3 consecutive failures

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

export async function startCollector() {
  if (started) return;
  await initMetricsProvider(); // ensure provider is ready
  if (!isMetricsEnabled()) {
    log.info("Metrics collection disabled — no provider configured");
    return;
  }
  started = true;
  tickCount = 0;
  log.info("Starting metrics collection (fast warmup: 5s × 20, then 30s)");

  // Initialize GPU collector (non-blocking — returns null on non-GPU hosts)
  initGpuCollector().catch((err) => {
    log.warn("GPU collector init failed:", (err as Error).message);
  });

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
  let metrics: Awaited<ReturnType<typeof fetchAllMetrics>> = [];
  try {
    metrics = await fetchAllMetrics();
    const results = await Promise.allSettled(
      metrics.flatMap((m) => {
        const ops = [
          storeMetrics(m.projectName, m.containerId, m.containerName, m.timestamp, {
            cpuPercent: m.cpuPercent,
            memoryUsage: m.memoryUsage,
            memoryLimit: m.memoryLimit,
            networkRxBytes: m.networkRxBytes,
            networkTxBytes: m.networkTxBytes,
          }, m.organizationId),
          storeDiskWrite(m.projectName, m.containerId, m.containerName, m.timestamp, m.diskWriteBytes, m.organizationId),
        ];
        // Only store GPU metrics when a GPU is present for this container
        if (m.gpuMemoryTotal > 0) {
          ops.push(storeGpuMetrics(m.projectName, m.containerId, m.containerName, m.timestamp, {
            gpuUtilization: m.gpuUtilization,
            gpuMemoryUsed: m.gpuMemoryUsed,
            gpuMemoryTotal: m.gpuMemoryTotal,
            gpuTemperature: m.gpuTemperature,
          }, m.organizationId));
        }
        return ops;
      })
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      log.error(`${results.length - failed} stored, ${failed} failed:`, (results.find((r) => r.status === "rejected") as PromiseRejectedResult)?.reason);
    }

    // GPU collector: supplement containers that cAdvisor didn't report GPU data for
    const gpuCollector = getGpuCollector();
    if (gpuCollector) {
      try {
        const containersWithGpu = new Set(
          metrics.filter((m) => m.gpuMemoryTotal > 0).map((m) => m.containerId),
        );
        const gpuMetrics = await Promise.race([
          gpuCollector.collect(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("GPU collection timed out")), 15_000),
          ),
        ]);
        setGpuSnapshot(gpuMetrics);
        const ts = Date.now();

        const gpuOps = gpuMetrics
          .filter((gm) => !containersWithGpu.has(gm.containerId))
          .map((gm) =>
            storeGpuMetrics(gm.projectName, gm.containerId, gm.containerName, ts, {
              gpuUtilization: gm.gpuUtilization,
              gpuMemoryUsed: gm.gpuMemoryUsed,
              gpuMemoryTotal: gm.gpuMemoryTotal,
              gpuTemperature: gm.gpuTemperature,
            }, gm.organizationId),
          );

        if (gpuOps.length > 0) {
          const gpuResults = await Promise.allSettled(gpuOps);
          const gpuFailed = gpuResults.filter((r) => r.status === "rejected").length;
          if (gpuFailed > 0) {
            log.error(`GPU store: ${gpuOps.length - gpuFailed} ok, ${gpuFailed} failed`);
          }
        }
      } catch (err) {
        log.warn("GPU collection error:", (err as Error).message);
      }
    }

    // Recovered — mark integration connected if it was degraded
    if (consecutiveFailures >= DEGRADED_THRESHOLD) {
      updateIntegrationHealth("connected");
    }
    consecutiveFailures = 0;
  } catch (err) {
    log.error("Error:", (err as Error).message);
    consecutiveFailures++;
    if (consecutiveFailures === DEGRADED_THRESHOLD) {
      updateIntegrationHealth("degraded");
    }
  }

  // Disk write alert check: every 6th tick after warmup (~3 min at 30s interval)
  // During warmup, skip to accumulate baseline data
  if (tickCount >= WARMUP_TICKS && tickCount % 6 === 0 && metrics.length > 0) {
    try {
      await checkDiskWriteAlerts(metrics);
    } catch (err) {
      log.error("Disk write alert check error:", (err as Error).message);
    }
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
      log.error("Disk error:", (err as Error).message);
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
      log.error("Per-project disk error:", (err as Error).message);
    }

    // Business metrics (entity counts)
    try {
      await collectBusinessMetrics();
    } catch (err) {
      log.error("Business metrics error:", (err as Error).message);
    }
  }
}

export function stopCollector() {
  if (timeout) {
    clearTimeout(timeout);
    timeout = null;
  }
  started = false;
}

/** Update metrics integration status (best-effort, non-blocking). */
function updateIntegrationHealth(status: "connected" | "degraded") {
  // Log metrics health status
  import("@/lib/config/features")
    .then(({ isFeatureEnabledAsync }) => isFeatureEnabledAsync("metrics"))
    .then((active) => {
      if (active) {
        log.info(`Metrics health: ${status}`);
      }
    })
    .catch(() => {}); // best-effort

}
