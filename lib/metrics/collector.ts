import { logger } from "@/lib/logger";
import { isMetricsEnabled, initMetricsProvider } from "./config";
import { fetchAllMetrics } from "./provider";
import { storeMetrics, storeDiskUsage, storeDiskWrite, storeGpuMetrics, storeProjectDisk, pruneStaleGpuSeries } from "./store";
import { checkDiskWriteAlerts } from "./disk-write-alerts";
import { getSystemDiskUsage, getPerProjectDiskUsage } from "@/lib/docker/client";
import { collectBusinessMetrics } from "./collect-business-metrics";
import { initGpuCollector, getGpuCollector, setGpuSnapshot } from "@/lib/gpu/collector";
import { setLatestSnapshot } from "./broadcast";

const log = logger.child("collector");

type CollectorState = {
  timeout: ReturnType<typeof setTimeout> | null;
  started: boolean;
  tickCount: number;
  consecutiveFailures: number;
  disabled: boolean;
  diskConsecutiveFailures: number;
  projectDiskConsecutiveFailures: number;
};

/**
 * Lifecycle state lives on globalThis. Next.js bundles instrumentation and route
 * handlers separately, so a module-local flag lets each one start its own tick loop.
 */
const globalForCollector = globalThis as unknown as { __vardo_metrics_collector?: CollectorState };

const state: CollectorState = (globalForCollector.__vardo_metrics_collector ??= {
  timeout: null,
  started: false,
  tickCount: 0,
  consecutiveFailures: 0,
  disabled: false,
  diskConsecutiveFailures: 0,
  projectDiskConsecutiveFailures: 0,
});

const DEGRADED_THRESHOLD = 3; // mark integration degraded after 3 consecutive failures

/** Once a disk-collection failure persists, only re-log it this often (in disk-check cycles). */
const DISK_ERROR_LOG_EVERY = 20;

const FAST_INTERVAL_MS = 5000;   // First 20 ticks: every 5s
const NORMAL_INTERVAL_MS = 30000; // After warmup: every 30s
const WARMUP_TICKS = 20;

/** Cap on the exponential backoff between failed collections. */
const MAX_BACKOFF_MS = 15 * 60_000;
/** Consecutive failures before the collector stops polling a provider that isn't there. */
const DISABLE_THRESHOLD = 20;

/**
 * Poll interval for the next tick. Failures back off exponentially from the
 * normal interval so an unreachable provider is retried occasionally rather
 * than every 30s forever.
 */
export function nextInterval(opts: { tickCount: number; consecutiveFailures: number }): number {
  if (opts.consecutiveFailures > 0) {
    const backoff = NORMAL_INTERVAL_MS * 2 ** (opts.consecutiveFailures - 1);
    return Math.min(backoff, MAX_BACKOFF_MS);
  }
  return opts.tickCount < WARMUP_TICKS ? FAST_INTERVAL_MS : NORMAL_INTERVAL_MS;
}

/**
 * Whether a persistent sub-collection failure (disk usage, per-project disk)
 * should be logged this cycle: the first occurrence, then every `every` cycles
 * while it keeps failing, instead of on every single cycle.
 */
export function shouldLogPersistentFailure(consecutiveFailures: number, every = DISK_ERROR_LOG_EVERY): boolean {
  return consecutiveFailures === 1 || consecutiveFailures % every === 0;
}

/**
 * Start the metrics collector.
 * Starts fast (every 5s for the first 20 ticks) then settles to every 30s.
 */
export function isCollectorRunning() {
  return state.started;
}

export async function startCollector() {
  if (state.started) return;
  await initMetricsProvider(); // ensure provider is ready
  if (!isMetricsEnabled()) {
    log.info("Metrics collection disabled — no provider configured");
    return;
  }
  state.started = true;
  state.tickCount = 0;
  state.consecutiveFailures = 0;
  state.diskConsecutiveFailures = 0;
  state.projectDiskConsecutiveFailures = 0;
  state.disabled = false;
  log.info("Starting metrics collection (fast warmup: 5s × 20, then 30s)");

  // Initialize GPU collector (non-blocking — returns null on non-GPU hosts)
  initGpuCollector().catch((err) => {
    log.warn("GPU collector init failed:", (err as Error).message);
  });

  scheduleTick();
}

function scheduleTick() {
  if (!state.started || state.disabled) return;
  const interval = nextInterval({
    tickCount: state.tickCount,
    consecutiveFailures: state.consecutiveFailures,
  });
  state.timeout = setTimeout(async () => {
    await collect();
    state.tickCount++;
    scheduleTick();
  }, interval);
}

async function collect() {
  let metrics: Awaited<ReturnType<typeof fetchAllMetrics>> = [];
  try {
    metrics = await fetchAllMetrics();
    setLatestSnapshot(metrics);
    const results = await Promise.allSettled(
      metrics.flatMap((m) => {
        // Stack children share the parent's project label; the service tells them apart.
        const service = m.labels["com.docker.compose.service"] ?? null;
        const ops = [
          storeMetrics(m.projectName, m.containerId, m.containerName, m.timestamp, {
            cpuPercent: m.cpuPercent,
            memoryUsage: m.memoryUsage,
            memoryLimit: m.memoryLimit,
            networkRxBytes: m.networkRxBytes,
            networkTxBytes: m.networkTxBytes,
          }, m.organizationId, service),
        ];
        // Writing an unreported counter as 0 is what made "no disk I/O data"
        // read as "wrote nothing".
        if (m.diskWriteBytes !== null) {
          ops.push(storeDiskWrite(m.projectName, m.containerId, m.containerName, m.timestamp, m.diskWriteBytes, m.organizationId, service));
        }
        // Only store GPU metrics when a GPU is present for this container
        if (m.gpuMemoryTotal > 0) {
          ops.push(storeGpuMetrics(m.projectName, m.containerId, m.containerName, m.timestamp, {
            gpuUtilization: m.gpuUtilization,
            gpuMemoryUsed: m.gpuMemoryUsed,
            gpuMemoryTotal: m.gpuMemoryTotal,
            gpuTemperature: m.gpuTemperature,
          }, m.organizationId, service));
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

        // The GPU resolver doesn't read Docker labels; take the service off the cAdvisor row.
        const serviceByContainer = new Map(
          metrics.map((m) => [m.containerId, m.labels["com.docker.compose.service"] ?? null]),
        );

        const gpuOps = gpuMetrics
          .filter((gm) => !containersWithGpu.has(gm.containerId))
          .map((gm) =>
            storeGpuMetrics(gm.projectName, gm.containerId, gm.containerName, ts, {
              gpuUtilization: gm.gpuUtilization,
              gpuMemoryUsed: gm.gpuMemoryUsed,
              gpuMemoryTotal: gm.gpuMemoryTotal,
              gpuTemperature: gm.gpuTemperature,
            }, gm.organizationId, serviceByContainer.get(gm.containerId) ?? null),
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
    if (state.consecutiveFailures >= DEGRADED_THRESHOLD) {
      log.info(`Metrics provider recovered after ${state.consecutiveFailures} failed collection(s)`);
      updateIntegrationHealth("connected");
    }
    state.consecutiveFailures = 0;
  } catch (err) {
    state.consecutiveFailures++;
    // Log the first failure and the shutdown, not each retry.
    if (state.consecutiveFailures === 1) {
      log.error("Error:", (err as Error).message);
    }
    if (state.consecutiveFailures === DEGRADED_THRESHOLD) {
      updateIntegrationHealth("degraded");
    }
    if (state.consecutiveFailures >= DISABLE_THRESHOLD) {
      state.disabled = true;
      log.error(
        `Metrics collection disabled after ${state.consecutiveFailures} consecutive failures — ` +
          `the provider is unreachable (${(err as Error).message}). ` +
          `Check the metrics integration, then restart Vardo or re-toggle the metrics feature.`,
      );
      return;
    }
  }

  // Disk write alert check: every 6th tick after warmup (~3 min at 30s interval)
  // During warmup, skip to accumulate baseline data
  if (state.tickCount >= WARMUP_TICKS && state.tickCount % 6 === 0 && metrics.length > 0) {
    try {
      await checkDiskWriteAlerts(metrics);
    } catch (err) {
      log.error("Disk write alert check error:", (err as Error).message);
    }
  }

  // Disk usage: every 10th tick during warmup, every 10th tick after (~5 min at 30s)
  const diskInterval = state.tickCount < WARMUP_TICKS ? 4 : 10; // Every 20s during warmup, every 5min after
  if (state.tickCount % diskInterval === 0) {
    try {
      const diskUsage = await getSystemDiskUsage();
      await storeDiskUsage(Date.now(), {
        images: diskUsage.images.totalSize,
        volumes: diskUsage.volumes.totalSize,
        buildCache: diskUsage.buildCache.totalSize,
        total: diskUsage.total,
      });
      if (state.diskConsecutiveFailures > 0) {
        log.info(`Disk usage recovered after ${state.diskConsecutiveFailures} failed collection(s)`);
      }
      state.diskConsecutiveFailures = 0;
    } catch (err) {
      state.diskConsecutiveFailures++;
      // Docker's /system/df can 404 on dangling containerd snapshots. Leave
      // disk usage unset (reported as unavailable, not zero) and don't spam
      // the log every cycle while it persists.
      if (shouldLogPersistentFailure(state.diskConsecutiveFailures)) {
        log.error(`Disk error (unavailable, ${state.diskConsecutiveFailures}x):`, (err as Error).message);
      }
    }

    try {
      const perProject = await getPerProjectDiskUsage();
      const ts = Date.now();
      await Promise.allSettled(
        Array.from(perProject.entries()).map(([name, size]) =>
          storeProjectDisk(name, ts, size)
        )
      );
      if (state.projectDiskConsecutiveFailures > 0) {
        log.info(`Per-project disk usage recovered after ${state.projectDiskConsecutiveFailures} failed collection(s)`);
      }
      state.projectDiskConsecutiveFailures = 0;
    } catch (err) {
      state.projectDiskConsecutiveFailures++;
      if (shouldLogPersistentFailure(state.projectDiskConsecutiveFailures)) {
        log.error(`Per-project disk error (unavailable, ${state.projectDiskConsecutiveFailures}x):`, (err as Error).message);
      }
    }

    // Business metrics (entity counts)
    try {
      await collectBusinessMetrics();
    } catch (err) {
      log.error("Business metrics error:", (err as Error).message);
    }

    // Sweep GPU series past retention.
    try {
      const pruned = await pruneStaleGpuSeries();
      if (pruned > 0) {
        log.info(`Pruned ${pruned} stale GPU series`);
      }
    } catch (err) {
      log.error("GPU prune error:", (err as Error).message);
    }
  }
}

export function stopCollector() {
  if (state.timeout) {
    clearTimeout(state.timeout);
    state.timeout = null;
  }
  state.started = false;
  state.disabled = false;
  state.diskConsecutiveFailures = 0;
  state.projectDiskConsecutiveFailures = 0;
}

/** True when the collector shut itself off after repeated provider failures. */
export function isCollectorDisabled() {
  return state.disabled;
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
