import { logger } from "@/lib/logger";
import type { ContainerGpuMetrics } from "./types";
import type { ContainerGpuSource, GpuInspect } from "./collector-source";

const log = logger.child("gpu-collector");

// Singleton on globalThis to survive Next.js module reloads.

const globalForGpu = globalThis as unknown as {
  __vardo_gpu_collector?: ContainerGpuSource | null;
  __vardo_gpu_snapshot?: ContainerGpuMetrics[];
};

/** GPU readings come only from the collector; off mode has none. */
export async function initGpuCollector(env: Record<string, string | undefined> = process.env): Promise<ContainerGpuSource | null> {
  if (globalForGpu.__vardo_gpu_collector) return globalForGpu.__vardo_gpu_collector;

  const { collectorMode, collectorTokenSource } = await import("@/lib/collector/config");
  const mode = collectorMode(env);
  if (mode.kind === "off") return null;

  const { CollectorClient } = await import("@/lib/collector/client");
  const { CollectorGpuCollector } = await import("./collector-source");
  const { dockerRequest } = await import("@/lib/docker/client");
  const instance = new CollectorGpuCollector(new CollectorClient(mode.url, collectorTokenSource(mode, env)), (id) =>
    dockerRequest<GpuInspect>("GET", `/containers/${encodeURIComponent(id)}/json`),
  );
  globalForGpu.__vardo_gpu_collector = instance;
  log.info(`GPU readings from the collector at ${mode.url}`);
  return instance;
}

/** Current GPU source, or null in off mode. */
export function getGpuCollector(): ContainerGpuSource | null {
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
