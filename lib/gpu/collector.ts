import { logger } from "@/lib/logger";
import type { ContainerGpuMetrics, ContainerResolver, GpuProvider } from "./types";

const log = logger.child("gpu-collector");

/** Produces per-container GPU metrics from a GpuProvider and ContainerResolver. Empty when no GPUs. */
export class GpuMetricsCollector {
  private provider: GpuProvider;
  private resolver: ContainerResolver;

  constructor(provider: GpuProvider, resolver: ContainerResolver) {
    this.provider = provider;
    this.resolver = resolver;
  }

  /** Per-container GPU metrics: per-process memory with utilization split proportionally. */
  async collect(): Promise<ContainerGpuMetrics[]> {
    const [deviceMetrics, processes] = await Promise.all([
      this.provider.getDeviceMetrics(),
      this.provider.getProcesses(),
    ]);

    if (deviceMetrics.length === 0) return [];

    const deviceByIndex = new Map(deviceMetrics.map((dm) => [dm.device.index, dm]));

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
        if (!containerId) return null;

        const app = await this.resolver.containerIdToApp(containerId);
        if (!app) return null;

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

    // Per-device total process memory.
    const deviceProcessMemory = new Map<number, number>();
    for (const rp of resolved) {
      deviceProcessMemory.set(
        rp.deviceIndex,
        (deviceProcessMemory.get(rp.deviceIndex) || 0) + rp.memoryUsed,
      );
    }

    const results: ContainerGpuMetrics[] = [];

    for (const entry of byContainer.values()) {
      // Utilization weighted by this container's share of process memory on each device.
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

// Singleton on globalThis to survive Next.js module reloads.

const globalForGpu = globalThis as unknown as {
  __vardo_gpu_collector?: GpuMetricsCollector | null;
  __vardo_gpu_snapshot?: ContainerGpuMetrics[];
};

/** Initializes the GPU collector with an auto-detected provider. */
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

/** Current GPU collector, or null without GPUs. */
export function getGpuCollector(): GpuMetricsCollector | null {
  return globalForGpu.__vardo_gpu_collector ?? null;
}

/** Stores the latest GPU snapshot. */
export function setGpuSnapshot(metrics: ContainerGpuMetrics[]): void {
  globalForGpu.__vardo_gpu_snapshot = metrics;
}

/** Latest GPU snapshot from the collector tick. */
export function getGpuSnapshot(): ContainerGpuMetrics[] {
  return globalForGpu.__vardo_gpu_snapshot ?? [];
}
