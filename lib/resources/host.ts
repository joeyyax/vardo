// The host's size from Docker's /info, read once per process and kept in memory.

import { availableParallelism } from "os";
import { logger } from "@/lib/logger";
import {
  describeDefaults,
  resolveDeployConcurrency,
  resolveTierCpus,
  resolveTierMemory,
  type HostSize,
  type QosTier,
  type ResourceDefault,
  type RunningLimits,
} from "./defaults";

const log = logger.child("resources");

/** How long a failed detection stands before the next call retries. */
const RETRY_AFTER_MS = 60_000;

type HostCache = { host: HostSize | null; at: number; pending: Promise<HostSize | null> | null };

// On globalThis so instrumentation and route bundles share one result.
const g = globalThis as unknown as { __vardo_host_size?: HostCache };
const cache = (g.__vardo_host_size ??= { host: null, at: 0, pending: null });

/** Reads the host's CPU count and memory. Cached; null when Docker can't be reached. */
export async function detectHost(): Promise<HostSize | null> {
  if (cache.host) return cache.host;
  if (cache.pending) return cache.pending;
  if (cache.at && Date.now() - cache.at < RETRY_AFTER_MS) return null;
  cache.pending = (async () => {
    try {
      const { getSystemInfo } = await import("@/lib/docker/client");
      const info = await getSystemInfo();
      if (!(info.cpus > 0) || !(info.memoryTotal > 0)) throw new Error("Docker reported no CPUs or memory");
      cache.host = { cpus: info.cpus, memoryBytes: info.memoryTotal };
      log.info(`Host: ${info.cpus} CPUs, ${(info.memoryTotal / 1024 ** 3).toFixed(1)} GiB`);
    } catch (err) {
      log.warn("Couldn't read the host's size from Docker; using fixed defaults:", err);
    } finally {
      cache.at = Date.now();
      cache.pending = null;
    }
    return cache.host;
  })();
  return cache.pending;
}

/** The detected host, or null before detection or after it failed. */
export function detectedHost(): HostSize | null {
  return cache.host;
}

/** Clears the cache. For tests. */
export function resetHostCache(host: HostSize | null = null): void {
  cache.host = host;
  cache.at = 0;
  cache.pending = null;
}

export function tierMemoryMb(tier: QosTier): number {
  return resolveTierMemory(tier, cache.host).value;
}

export function tierCpuLimit(tier: QosTier, hostCpus?: number): number | null {
  const host = hostCpus !== undefined ? { cpus: hostCpus, memoryBytes: cache.host?.memoryBytes ?? 0 } : cache.host;
  return resolveTierCpus(tier, host, availableParallelism()).value;
}

export function maxDeployConcurrency(): number {
  return resolveDeployConcurrency(cache.host).value;
}

async function containerMemoryMb(name: string): Promise<number | null> {
  try {
    const { inspectContainer } = await import("@/lib/docker/client");
    const bytes = (await inspectContainer(name)).memoryBytes;
    return bytes > 0 ? Math.round(bytes / 1024 / 1024) : null;
  } catch {
    return null;
  }
}

async function redisMaxmemoryMb(): Promise<number | null> {
  try {
    const { redis } = await import("@/lib/redis");
    const info = await redis.info("memory");
    const bytes = Number(info.match(/^maxmemory:(\d+)/m)?.[1]);
    return bytes > 0 ? Math.round(bytes / 1024 / 1024) : null;
  } catch {
    return null;
  }
}

/** The running limits for values install.sh sets. */
export async function runningLimits(): Promise<RunningLimits> {
  const { buildKitContainerName, DEFAULT_BUILDKIT_HOST } = await import("@/lib/docker/buildkit");
  const buildkit = buildKitContainerName(process.env.BUILDKIT_HOST || DEFAULT_BUILDKIT_HOST) ?? "vardo-buildkit";
  const [buildkitMemMb, redisMemMb, redisMax] = await Promise.all([
    containerMemoryMb(buildkit),
    containerMemoryMb("vardo-redis"),
    redisMaxmemoryMb(),
  ]);
  return { buildkitMemMb, redisMemMb, redisMaxmemoryMb: redisMax };
}

/** Every sized default for the admin page. */
export async function currentDefaults(): Promise<{ host: HostSize | null; defaults: ResourceDefault[] }> {
  const [host, running] = await Promise.all([detectHost(), runningLimits()]);
  return { host, defaults: describeDefaults(host, availableParallelism(), process.env, running) };
}
