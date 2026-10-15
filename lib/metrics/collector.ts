import { logger } from "@/lib/logger";
import { backoffDelay } from "@/lib/net/backoff";
import { isMetricsLoopEnabled, initMetricsProvider } from "./config";
import { fetchAllMetrics, metricsPollIntervalMs } from "./provider";
import { storeMetrics, storeDiskUsage, storeDiskWrite, storeGpuMetrics, storeProjectDisk, pruneStaleGpuSeries } from "./store";
import { checkDiskWriteAlerts } from "./disk-write-alerts";
import { getDiskSnapshot } from "@/lib/docker/disk-snapshot";
import { collectBusinessMetrics } from "./collect-business-metrics";
import { initGpuCollector, getGpuCollector, setGpuSnapshot } from "@/lib/gpu/collector";
import { publishGpuSnapshot } from "@/lib/gpu/snapshot-store";
import { setLatestSnapshot } from "./broadcast";
import { IntervalLoop, type LoopRole } from "@/lib/worker/interval-loop";
import { MetricsNotReadyError } from "./not-ready";

const log = logger.child("collector");

type CollectorState = {
  started: boolean;
  tickCount: number;
  consecutiveFailures: number;
  diskConsecutiveFailures: number;
  projectDiskConsecutiveFailures: number;
};

/** State lives on globalThis; Next.js bundles instrumentation and routes separately, which would start two loops. */
const globalForCollector = globalThis as unknown as {
  __vardo_metrics_collector?: CollectorState;
  __vardo_metrics_collector_loop?: IntervalLoop;
};

const state: CollectorState = (globalForCollector.__vardo_metrics_collector ??= {
  started: false,
  tickCount: 0,
  consecutiveFailures: 0,
  diskConsecutiveFailures: 0,
  projectDiskConsecutiveFailures: 0,
});

const DEGRADED_THRESHOLD = 3;

/** Re-log a persistent disk failure every N disk-check cycles. */
const DISK_ERROR_LOG_EVERY = 20;

const FAST_INTERVAL_MS = 5000;
const NORMAL_INTERVAL_MS = 30000;
const WARMUP_TICKS = 20;

/** Cap on the exponential backoff between failed collections. The loop never gives up. */
const MAX_BACKOFF_MS = 2 * 60_000;

/** Interval for the next tick. Failures back off exponentially; warmup never polls faster than the provider updates. */
export function nextInterval(opts: { tickCount: number; consecutiveFailures: number; providerIntervalMs?: number }): number {
  if (opts.consecutiveFailures > 0) {
    return backoffDelay(opts.consecutiveFailures, { baseMs: NORMAL_INTERVAL_MS, maxMs: MAX_BACKOFF_MS, jitter: "none" });
  }
  if (opts.tickCount >= WARMUP_TICKS) return NORMAL_INTERVAL_MS;
  return Math.min(NORMAL_INTERVAL_MS, Math.max(FAST_INTERVAL_MS, opts.providerIntervalMs ?? FAST_INTERVAL_MS));
}

/** Whether a persistent sub-collection failure logs this cycle: first, then every `every` cycles. */
export function shouldLogPersistentFailure(consecutiveFailures: number, every = DISK_ERROR_LOG_EVERY): boolean {
  return consecutiveFailures === 1 || consecutiveFailures % every === 0;
}

export function isCollectorRunning() {
  return state.started;
}

/** Starts the collector: every 5s for the first 20 ticks, then every 30s. */
export async function startCollector(role: LoopRole = "web") {
  if (state.started) return;
  await initMetricsProvider();
  if (!isMetricsLoopEnabled()) {
    log.info("Metrics collection disabled — the metrics feature is off");
    return;
  }
  state.started = true;
  state.tickCount = 0;
  state.consecutiveFailures = 0;
  state.diskConsecutiveFailures = 0;
  state.projectDiskConsecutiveFailures = 0;
  log.info("Starting metrics collection (fast warmup: 5s × 20, then 30s)");

  // Null in off mode.
  initGpuCollector().catch((err) => {
    log.warn("GPU collector init failed:", (err as Error).message);
  });

  collectorLoop.start({ role });
}

/** Per process: it feeds this process's live snapshot. Waits a full interval after each collection. */
export const collectorLoop = (globalForCollector.__vardo_metrics_collector_loop ??= new IntervalLoop({
  name: "metrics-collector",
  intervalMs: () =>
    nextInterval({
      tickCount: state.tickCount,
      consecutiveFailures: state.consecutiveFailures,
      providerIntervalMs: metricsPollIntervalMs(),
    }),
  schedule: "delay",
  log,
  run: async () => {
    await collect();
    state.tickCount++;
  },
}));

async function collect() {
  let metrics: Awaited<ReturnType<typeof fetchAllMetrics>> = [];
  try {
    metrics = await fetchAllMetrics();
    setLatestSnapshot(metrics);
    const results = await Promise.allSettled(
      metrics.flatMap((m) => {
        // Stack children share the parent's project label; the service tells them apart.
        const service = m.labels["com.docker.compose.service"] ?? null;
        const environment = m.labels["vardo.environment"] ?? m.labels["host.environment"] ?? null;
        const ops = [
          storeMetrics(m.projectName, m.containerId, m.containerName, m.timestamp, {
            cpuPercent: m.cpuPercent,
            memoryUsage: m.memoryUsage,
            memoryLimit: m.memoryLimit,
            networkRxBytes: m.networkRxBytes,
            networkTxBytes: m.networkTxBytes,
          }, m.organizationId, service, environment),
        ];
        // Skip unreported counters; storing 0 reads as "wrote nothing".
        if (m.diskWriteBytes !== null) {
          ops.push(storeDiskWrite(m.projectName, m.containerId, m.containerName, m.timestamp, m.diskWriteBytes, m.organizationId, service));
        }
        return ops;
      })
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      log.error(`${results.length - failed} stored, ${failed} failed:`, (results.find((r) => r.status === "rejected") as PromiseRejectedResult)?.reason);
    }

    // GPU readings from the collector, per container.
    const gpuCollector = getGpuCollector();
    if (gpuCollector) {
      try {
        const gpuMetrics = await Promise.race([
          gpuCollector.collect(metrics),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("GPU collection timed out")), 15_000),
          ),
        ]);
        setGpuSnapshot(gpuMetrics);
        await publishGpuSnapshot(gpuMetrics).catch((err) => log.warn("GPU snapshot publish failed:", (err as Error).message));
        const ts = Date.now();

        // GPU readings carry no labels; take the service from the metrics snapshot.
        const serviceByContainer = new Map(
          metrics.map((m) => [m.containerId, m.labels["com.docker.compose.service"] ?? null]),
        );

        const gpuOps = gpuMetrics.map((gm) =>
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
    // Up but not collected twice yet: a skipped tick, not a failure.
    if (err instanceof MetricsNotReadyError) {
      log.debug(`Skipped a tick: ${err.message}`);
    } else {
      state.consecutiveFailures++;
      if (shouldLogPersistentFailure(state.consecutiveFailures)) {
        log.error(`Error (${state.consecutiveFailures}x):`, (err as Error).message);
      }
      if (state.consecutiveFailures === DEGRADED_THRESHOLD) {
        updateIntegrationHealth("degraded");
      }
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

export function stopCollector(): Promise<void> {
  const stopped = collectorLoop.stop();
  state.started = false;
  state.diskConsecutiveFailures = 0;
  state.projectDiskConsecutiveFailures = 0;
  return stopped;
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
