import { logger } from "@/lib/logger";
import { backoffDelay } from "@/lib/net/backoff";
import { isMetricsEnabled, initMetricsProvider } from "./config";
import { fetchAllMetrics } from "./provider";
import { storeMetrics, storeDiskUsage, storeDiskWrite, storeGpuMetrics, storeProjectDisk, pruneStaleGpuSeries } from "./store";
import { checkDiskWriteAlerts } from "./disk-write-alerts";
import { getDiskSnapshot } from "@/lib/docker/disk-snapshot";
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

/** State lives on globalThis; Next.js bundles instrumentation and routes separately, which would start two loops. */
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

const DEGRADED_THRESHOLD = 3;

/** Re-log a persistent disk failure every N disk-check cycles. */
const DISK_ERROR_LOG_EVERY = 20;

const FAST_INTERVAL_MS = 5000;
const NORMAL_INTERVAL_MS = 30000;
const WARMUP_TICKS = 20;

/** Cap on the exponential backoff between failed collections. */
const MAX_BACKOFF_MS = 15 * 60_000;
/** Consecutive failures before the collector stops polling. */
const DISABLE_THRESHOLD = 20;

/** Interval for the next tick. Failures back off exponentially from the normal interval. */
export function nextInterval(opts: { tickCount: number; consecutiveFailures: number }): number {
  if (opts.consecutiveFailures > 0) {
    return backoffDelay(opts.consecutiveFailures, { baseMs: NORMAL_INTERVAL_MS, maxMs: MAX_BACKOFF_MS, jitter: "none" });
  }
  return opts.tickCount < WARMUP_TICKS ? FAST_INTERVAL_MS : NORMAL_INTERVAL_MS;
}

/** Whether a persistent sub-collection failure logs this cycle: first, then every `every` cycles. */
export function shouldLogPersistentFailure(consecutiveFailures: number, every = DISK_ERROR_LOG_EVERY): boolean {
  return consecutiveFailures === 1 || consecutiveFailures % every === 0;
}

export function isCollectorRunning() {
  return state.started;
}

/** Starts the collector: every 5s for the first 20 ticks, then every 30s. */
export async function startCollector() {
  if (state.started) return;
  await initMetricsProvider();
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

  // Returns null on non-GPU hosts.
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
        // Skip unreported counters; storing 0 reads as "wrote nothing".
        if (m.diskWriteBytes !== null) {
          ops.push(storeDiskWrite(m.projectName, m.containerId, m.containerName, m.timestamp, m.diskWriteBytes, m.organizationId, service));
        }
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

    // Fill GPU data cAdvisor didn't report.
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

        // The GPU resolver doesn't read labels; take the service from cAdvisor.
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

  // Disk write alerts: every 6th tick after warmup.
  if (state.tickCount >= WARMUP_TICKS && state.tickCount % 6 === 0 && metrics.length > 0) {
    try {
      await checkDiskWriteAlerts(metrics);
    } catch (err) {
      log.error("Disk write alert check error:", (err as Error).message);
    }
  }

  // Disk usage: every 4th tick during warmup, every 10th after.
  const diskInterval = state.tickCount < WARMUP_TICKS ? 4 : 10;
  if (state.tickCount % diskInterval === 0) {
    // One df call serves both the system totals and the per-project figures.
    let snapshot: Awaited<ReturnType<typeof getDiskSnapshot>> | null = null;
    try {
      snapshot = await getDiskSnapshot();
      const diskUsage = snapshot.usage;
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
      // /system/df can 404 on dangling containerd snapshots. Leave disk unset, not zero.
      if (shouldLogPersistentFailure(state.diskConsecutiveFailures)) {
        log.error(`Disk error (unavailable, ${state.diskConsecutiveFailures}x):`, (err as Error).message);
      }
    }

    try {
      if (!snapshot) throw new Error("no disk snapshot");
      const ts = Date.now();
      await Promise.allSettled(
        Array.from(snapshot.perProject.entries()).map(([name, size]) =>
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

/** Updates metrics integration status. Best-effort. */
function updateIntegrationHealth(status: "connected" | "degraded") {
  import("@/lib/config/features")
    .then(({ isFeatureEnabledAsync }) => isFeatureEnabledAsync("metrics"))
    .then((active) => {
      if (active) {
        log.info(`Metrics health: ${status}`);
      }
    })
    .catch(() => {});

}
