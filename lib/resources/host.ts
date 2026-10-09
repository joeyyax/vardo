// The host's size from Docker's /info, read once per process and kept in memory.

import { availableParallelism } from "os";
import { logger } from "@/lib/logger";
import {
  describeDefaults,
  parseAdminSettings,
  resolveDeployConcurrency,
  resolveTierCpus,
  resolveTierMemory,
  type AdminResourceSettings,
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

/** The system_settings key holding admin-set defaults. */
export const RESOURCE_SETTINGS_KEY = "resource_defaults";

// Last admin values read from the database, shared across bundles like the host size.
const sg = globalThis as unknown as { __vardo_resource_settings?: { values: AdminResourceSettings } };
const settings = (sg.__vardo_resource_settings ??= { values: {} });

/** Reads the admin-set defaults from the database. Keeps the last values when the read fails. */
export async function loadResourceSettings(): Promise<AdminResourceSettings> {
  try {
    const { getSystemSettingRaw, invalidateSettingsCache } = await import("@/lib/system-settings");
    invalidateSettingsCache(RESOURCE_SETTINGS_KEY);
    const raw = await getSystemSettingRaw(RESOURCE_SETTINGS_KEY);
    settings.values = raw ? parseAdminSettings(JSON.parse(raw)) : {};
  } catch (err) {
    log.warn("Couldn't read the admin resource defaults; keeping the last values:", err);
  }
  return settings.values;
}

/** Stores the admin-set defaults and updates the in-memory copy. */
export async function saveResourceSettings(values: AdminResourceSettings): Promise<void> {
  const { setSystemSetting } = await import("@/lib/system-settings");
  await setSystemSetting(RESOURCE_SETTINGS_KEY, JSON.stringify(values));
  settings.values = { ...values };
}

/** Sets the in-memory admin values. For tests. */
export function setResourceSettingsCache(values: AdminResourceSettings = {}): void {
  settings.values = { ...values };
}

export function tierMemoryMb(tier: QosTier): number {
  const key = tier === "critical" ? "memoryCritical" : tier === "standard" ? "memoryStandard" : "memoryDisposable";
  return resolveTierMemory(tier, cache.host, process.env, settings.values[key]).value;
}

export function tierCpuLimit(tier: QosTier, hostCpus?: number): number | null {
  const host = hostCpus !== undefined ? { cpus: hostCpus, memoryBytes: cache.host?.memoryBytes ?? 0 } : cache.host;
  const admin =
    tier === "standard" ? settings.values.cpusStandard : tier === "disposable" ? settings.values.cpusDisposable : undefined;
  return resolveTierCpus(tier, host, availableParallelism(), process.env, admin).value;
}

export function maxDeployConcurrency(): number {
  return resolveDeployConcurrency(cache.host, process.env, settings.values.deployConcurrency).value;
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

/** Size of the disk behind the console's root filesystem, which on an overlay is the host's. Null when unreadable. */
async function diskTotalBytes(): Promise<number | null> {
  try {
    const { statfs } = await import("fs/promises");
    const s = await statfs("/");
    const bytes = Number(s.blocks) * Number(s.bsize);
    return bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** Every sized default for the admin page. */
export async function currentDefaults(): Promise<{ host: HostSize | null; defaults: ResourceDefault[] }> {
  const [host, running, admin, disk] = await Promise.all([
    detectHost(),
    runningLimits(),
    loadResourceSettings(),
    diskTotalBytes(),
  ]);
  return { host, defaults: describeDefaults(host, availableParallelism(), process.env, running, admin, disk) };
}

/** The host's CPU count, or this process's when Docker can't be read. */
export function hostCpuCount(host: HostSize | null): number {
  return host?.cpus ?? availableParallelism();
}
