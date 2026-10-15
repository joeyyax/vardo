// Per-container GPU readings from the collector.

import type { CollectorClient, CollectorGpu } from "@/lib/collector/client";
import type { ContainerMetrics } from "@/lib/metrics/types";
import type { ContainerGpuMetrics } from "./types";

/** Anything that turns a metrics snapshot into per-container GPU readings. */
export interface ContainerGpuSource {
  collect(containers: ContainerMetrics[]): Promise<ContainerGpuMetrics[]>;
}

/** GPUs a container was given: every one, some by index or UUID, or none. */
export type GpuAccess = "all" | string[] | null;

/** The inspect fields that say whether a container has GPUs. */
export type GpuInspect = {
  HostConfig?: {
    Runtime?: string;
    DeviceRequests?: { Driver?: string; Count?: number; DeviceIDs?: string[] | null; Capabilities?: string[][] | null }[] | null;
  };
  Config?: { Env?: string[] | null };
};

/** GPU access from `deploy.resources.reservations.devices` / `--gpus`, or `runtime: nvidia` with NVIDIA_VISIBLE_DEVICES. */
export function gpuAccess(inspect: GpuInspect): GpuAccess {
  const requests = (inspect.HostConfig?.DeviceRequests ?? []).filter(
    (r) => r.Driver === "nvidia" || (r.Capabilities ?? []).some((set) => set.includes("gpu")),
  );
  if (requests.length > 0) {
    const ids = requests.flatMap((r) => r.DeviceIDs ?? []);
    return ids.length > 0 ? ids.map(normalizeGpuId) : "all";
  }
  if (inspect.HostConfig?.Runtime !== "nvidia") return null;
  const visible = (inspect.Config?.Env ?? []).find((e) => e.startsWith("NVIDIA_VISIBLE_DEVICES="))?.split("=")[1]?.trim();
  if (!visible || visible === "none" || visible === "void") return null;
  if (visible === "all") return "all";
  return visible.split(",").map((v) => normalizeGpuId(v.trim())).filter(Boolean);
}

function normalizeGpuId(id: string): string {
  return id.replace(/^GPU-/i, "").toLowerCase();
}

function hasDevice(access: GpuAccess, gpu: CollectorGpu): boolean {
  if (access === "all") return true;
  if (!access) return false;
  return access.includes(String(gpu.index)) || access.includes(normalizeGpuId(gpu.uuid));
}

/**
 * Each container's GPU memory from the collector, with a device's utilization split by its share of that device's memory.
 * Containers holding no GPU memory get no reading.
 */
export function attributeGpuMemory(gpus: CollectorGpu[], containers: ContainerMetrics[]): ContainerGpuMetrics[] {
  const devices = new Map(gpus.map((g) => [normalizeGpuId(g.uuid), g]));
  const held = new Map<string, number>();
  for (const m of containers) {
    for (const g of m.gpus ?? []) {
      const id = normalizeGpuId(g.uuid);
      if (devices.has(id)) held.set(id, (held.get(id) ?? 0) + g.memoryUsedBytes);
    }
  }

  const out: ContainerGpuMetrics[] = [];
  for (const m of containers) {
    let utilization = 0;
    let memoryUsed = 0;
    let memoryTotal = 0;
    let temperature = 0;
    let onDevice = false;
    for (const g of m.gpus ?? []) {
      const id = normalizeGpuId(g.uuid);
      const device = devices.get(id);
      if (!device) continue;
      onDevice = true;
      memoryUsed += g.memoryUsedBytes;
      utilization += (device.utilization_ratio ?? 0) * 100 * (g.memoryUsedBytes / (held.get(id) || 1));
      memoryTotal = Math.max(memoryTotal, device.memory_total_bytes ?? 0);
      temperature = Math.max(temperature, device.temperature_celsius ?? 0);
    }
    if (!onDevice) continue;
    out.push({
      containerId: m.containerId,
      containerName: m.containerName,
      projectName: m.projectName,
      organizationId: m.organizationId,
      gpuUtilization: Math.round(utilization * 100) / 100,
      gpuMemoryUsed: Math.round(memoryUsed),
      gpuMemoryTotal: memoryTotal,
      gpuTemperature: temperature,
    });
  }
  return out;
}

/**
 * Device readings split evenly across the containers that share each GPU.
 * Only for a collector that reports no per-container memory: before 0.2.0 or without `pid: host`.
 */
export function attributeGpus(
  gpus: CollectorGpu[],
  containers: { metrics: ContainerMetrics; access: GpuAccess }[],
): ContainerGpuMetrics[] {
  const devices = gpus.filter((g) => (g.memory_total_bytes ?? 0) > 0);
  const sharers = new Map(devices.map((g) => [g.index, containers.filter((c) => hasDevice(c.access, g)).length]));

  const out: ContainerGpuMetrics[] = [];
  for (const { metrics: m, access } of containers) {
    const mine = devices.filter((g) => hasDevice(access, g));
    if (mine.length === 0) continue;
    let utilization = 0;
    let memoryUsed = 0;
    let memoryTotal = 0;
    let temperature = 0;
    for (const g of mine) {
      const share = 1 / (sharers.get(g.index) || 1);
      utilization += (g.utilization_ratio ?? 0) * 100 * share;
      memoryUsed += (g.memory_used_bytes ?? 0) * share;
      memoryTotal = Math.max(memoryTotal, g.memory_total_bytes ?? 0);
      temperature = Math.max(temperature, g.temperature_celsius ?? 0);
    }
    out.push({
      containerId: m.containerId,
      containerName: m.containerName,
      projectName: m.projectName,
      organizationId: m.organizationId,
      gpuUtilization: Math.round(utilization * 100) / 100,
      gpuMemoryUsed: Math.round(memoryUsed),
      gpuMemoryTotal: memoryTotal,
      gpuTemperature: temperature,
    });
  }
  return out;
}

/** The collector's own container holds GPUs only to run nvidia-smi. */
function isCollector(m: ContainerMetrics): boolean {
  return m.containerName === "collector" || m.labels["com.docker.compose.service"] === "collector";
}

export class CollectorGpuCollector implements ContainerGpuSource {
  /** GPU access by full container id, for the even split. Fixed for a container's life, so inspected once. */
  private access = new Map<string, GpuAccess>();

  constructor(
    private readonly client: CollectorClient,
    private readonly inspect: (id: string) => Promise<GpuInspect>,
  ) {}

  async collect(containers: ContainerMetrics[]): Promise<ContainerGpuMetrics[]> {
    const gpus = (await this.client.host()).gpus ?? [];
    if (gpus.length === 0) return [];

    const candidates = containers.filter((m) => !isCollector(m));
    if (candidates.some((m) => (m.gpus?.length ?? 0) > 0)) return attributeGpuMemory(gpus, candidates);

    const ids = new Set(candidates.map((m) => m.containerIdFull || m.containerId));
    for (const id of this.access.keys()) if (!ids.has(id)) this.access.delete(id);

    await Promise.all(
      [...ids].filter((id) => !this.access.has(id)).map(async (id) => {
        try {
          this.access.set(id, gpuAccess(await this.inspect(id)));
        } catch {
          // Gone or unreadable; tried again next tick.
        }
      }),
    );

    return attributeGpus(
      gpus,
      candidates.map((m) => ({ metrics: m, access: this.access.get(m.containerIdFull || m.containerId) ?? null })),
    );
  }
}
