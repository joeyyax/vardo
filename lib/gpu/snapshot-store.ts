// The collector's GPU snapshot in Redis, so live streams in web read what the worker collected.

import { redis } from "@/lib/redis";
import { getGpuCollector, getGpuSnapshot } from "./collector";
import type { ContainerGpuMetrics } from "./types";

export const GPU_SNAPSHOT_KEY = "metrics:gpu:snapshot";
/** Outlives a few collector ticks, so a stopped collector's snapshot expires. */
export const GPU_SNAPSHOT_TTL_MS = 120_000;

export async function publishGpuSnapshot(metrics: ContainerGpuMetrics[]): Promise<void> {
  await redis.set(GPU_SNAPSHOT_KEY, JSON.stringify(metrics), "PX", GPU_SNAPSHOT_TTL_MS);
}

/** This process's snapshot when it collects GPUs, else the published one. Empty when neither has one. */
export async function readGpuSnapshot(): Promise<ContainerGpuMetrics[]> {
  if (getGpuCollector()) return getGpuSnapshot();
  try {
    const raw = await redis.get(GPU_SNAPSHOT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ContainerGpuMetrics[]) : [];
  } catch {
    return [];
  }
}
