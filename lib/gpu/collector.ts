import { logger } from "@/lib/logger";
import type { ContainerGpuMetrics, ContainerResolver, GpuProvider } from "./types";

const log = logger.child("gpu-collector");

/**
 * GPU metrics collector — orchestrates a GpuProvider + ContainerResolver
 * to produce per-container GPU metrics.
 *
 * Called on each metrics tick. Returns empty array gracefully when no
 * GPUs are present or nvidia-smi isn't available.
 */
export class GpuMetricsCollector {
  private provider: GpuProvider;
  private resolver: ContainerResolver;

  constructor(provider: GpuProvider, resolver: ContainerResolver) {
    this.provider = provider;
    this.resolver = resolver;
  }

  /**
   * Collect per-container GPU metrics.
   *
   * 1. Get device-level metrics (utilization, temp, memory)
   * 2. Get per-process GPU memory from nvidia-smi
   * 3. Map each process PID → container → Vardo app
   * 4. Aggregate per-container, with proportional utilization estimate
   *
   * Only called when initGpuCollector() already confirmed GPUs are present.
   */
  async collect(): Promise<ContainerGpuMetrics[]> {

    const [deviceMetrics, processes] = await Promise.all([
      this.provider.getDeviceMetrics(),
      this.provider.getProcesses(),
    ]);

    log.info(`collect: ${deviceMetrics.length} devices, ${processes.length} processes`);
    for (const proc of processes) {
      log.info(`  process: pid=${proc.pid}, device=${proc.deviceIndex}, mem=${Math.round(proc.memoryUsed / 1024 / 1024)}MiB`);
    }

    if (deviceMetrics.length === 0) return [];

    // Build device-level lookup by index
    const deviceByIndex = new Map(deviceMetrics.map((dm) => [dm.device.index, dm]));

    // Map processes to containers (parallel — each /proc read is independent)
    type ResolvedProcess = {
      containerId: string;
      projectName: string;
      containerName: string;
      organizationId: string | null;
      deviceIndex: number;
      memoryUsed: number;
    };

    const resolveResults = await Promise.all(
      processes.map(async (proc): Promise<ResolvedProcess | null> => {
        const containerId = await this.resolver.pidToContainerId(proc.pid);
        if (!containerId) {
          log.info(`  pid ${proc.pid}: no container found`);
          return null;
        }

        const app = await this.resolver.containerIdToApp(containerId);
        if (!app) {
          log.info(`  pid ${proc.pid}: container ${containerId} not a vardo app`);
          return null;
        }

        log.info(`  pid ${proc.pid}: → ${app.projectName}/${app.containerName}`);
        return {
          containerId,
          projectName: app.projectName,
          containerName: app.containerName,
          organizationId: app.organizationId,
          deviceIndex: proc.deviceIndex,
          memoryUsed: proc.memoryUsed,
        };
      }),
    );

    const resolved = resolveResults.filter((r): r is ResolvedProcess => r !== null);

    // Aggregate by container
    const byContainer = new Map<string, {
      containerId: string;
      containerName: string;
      projectName: string;
      organizationId: string | null;
      totalMemoryUsed: number;
      deviceIndices: Set<number>;
    }>();

    for (const rp of resolved) {
      const key = rp.containerId;
      const existing = byContainer.get(key);
      if (existing) {
        existing.totalMemoryUsed += rp.memoryUsed;
        existing.deviceIndices.add(rp.deviceIndex);
      } else {
        byContainer.set(key, {
          containerId: rp.containerId,
          containerName: rp.containerName,
          projectName: rp.projectName,
          organizationId: rp.organizationId,
          totalMemoryUsed: rp.memoryUsed,
          deviceIndices: new Set([rp.deviceIndex]),
        });
      }
    }

    // Compute per-device total process memory (for proportional utilization)
    const deviceProcessMemory = new Map<number, number>();
    for (const rp of resolved) {
      deviceProcessMemory.set(
        rp.deviceIndex,
        (deviceProcessMemory.get(rp.deviceIndex) || 0) + rp.memoryUsed,
      );
    }

    // Build final metrics
    const results: ContainerGpuMetrics[] = [];

    for (const entry of byContainer.values()) {
      // Weighted utilization: proportion of GPU memory this container uses
      // relative to total process memory on each device it touches
      let weightedUtil = 0;
      let maxTemp = 0;
      let totalDeviceMemory = 0;

      for (const devIdx of entry.deviceIndices) {
        const dm = deviceByIndex.get(devIdx);
        if (!dm) continue;

        const deviceTotal = deviceProcessMemory.get(devIdx) || 1;
        const containerShare = entry.totalMemoryUsed / deviceTotal;

        weightedUtil += dm.utilization * containerShare;
        maxTemp = Math.max(maxTemp, dm.temperature);
        totalDeviceMemory = Math.max(totalDeviceMemory, dm.memoryTotal);
      }

      results.push({
        containerId: entry.containerId,
        containerName: entry.containerName,
        projectName: entry.projectName,
        organizationId: entry.organizationId,
        gpuUtilization: Math.round(weightedUtil * 100) / 100,
        gpuMemoryUsed: entry.totalMemoryUsed,
        gpuMemoryTotal: totalDeviceMemory,
        gpuTemperature: maxTemp,
      });
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Singleton management — uses globalThis to survive Next.js module reloads
// ---------------------------------------------------------------------------

const globalForGpu = globalThis as unknown as { __vardo_gpu_collector?: GpuMetricsCollector | null };

/** Initialize the GPU collector with auto-detected provider. */
export async function initGpuCollector(): Promise<GpuMetricsCollector | null> {
  if (globalForGpu.__vardo_gpu_collector) return globalForGpu.__vardo_gpu_collector;

  const { NvidiaProvider } = await import("./providers/nvidia");
  const { DockerContainerResolver } = await import("./resolver");

  const provider = new NvidiaProvider();
  const devices = await provider.detectDevices();

  if (devices.length === 0) {
    log.info("No GPUs detected — GPU collector disabled");
    return null;
  }

  const resolver = new DockerContainerResolver();
  const instance = new GpuMetricsCollector(provider, resolver);
  globalForGpu.__vardo_gpu_collector = instance;
  log.info(`GPU collector initialized — ${devices.length} ${provider.vendor} GPU(s): ${devices.map((d) => d.name).join(", ")}`);
  return instance;
}

/** Get the current GPU collector instance (null if not initialized or no GPUs). */
export function getGpuCollector(): GpuMetricsCollector | null {
  return globalForGpu.__vardo_gpu_collector ?? null;
}
