// Sizes BuildKit's memory to the host before a build goes into an empty builder.

import { readFile } from "fs/promises";
import { parseMeminfo } from "@/lib/alerts/host";
import { buildkitMemGb, parseSizeMb } from "@/lib/resources/defaults";
import { dockerRequest } from "./client";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export const BUILDKIT_SIZE = {
  /** A build always gets at least this, or this share of RAM on a smaller host. */
  floorBytes: 4 * GiB,
  floorShare: 0.7,
  /** And at most half of RAM, unless the floor is more. */
  ceilingShare: 0.5,
  /** Kept back for the apps: a tenth of RAM, at least 1 GiB. */
  reserveShare: 0.1,
  reserveMinBytes: 1 * GiB,
  /** Below this much RAM, BuildKit gets swap equal to its memory. */
  swapBelowBytes: 6 * GiB,
  /** Sizes round down to this step; a smaller change doesn't resize. */
  stepBytes: 64 * MiB,
} as const;

export type BuildKitSize = { memoryBytes: number; memorySwapBytes: number; reserveBytes: number; floored: boolean };

/** Free memory plus what BuildKit holds now, less the apps' reserve, between the floor and half of RAM. The floor wins on a small host. */
export function buildkitSize(input: { totalBytes: number; availableBytes: number; builderBytes: number }): BuildKitSize {
  const s = BUILDKIT_SIZE;
  const reserveBytes = Math.max(s.reserveMinBytes, input.totalBytes * s.reserveShare);
  const floor = Math.min(s.floorBytes, input.totalBytes * s.floorShare);
  const ceiling = input.totalBytes * s.ceilingShare;
  const wanted = input.availableBytes + input.builderBytes - reserveBytes;
  const sized = Math.max(floor, Math.min(ceiling, wanted));
  const memoryBytes = Math.floor(sized / s.stepBytes) * s.stepBytes;
  const memorySwapBytes = input.totalBytes < s.swapBelowBytes ? memoryBytes * 2 : memoryBytes;
  return { memoryBytes, memorySwapBytes, reserveBytes, floored: wanted < floor };
}

/** Whether VARDO_BUILDKIT_MEM pins BuildKit's size: set to something other than what install.sh writes for this host. */
export function pinnedBuildKitMem(env: Record<string, string | undefined>, totalBytes: number): number | null {
  const raw = env.VARDO_BUILDKIT_MEM;
  const mb = raw ? parseSizeMb(raw) : null;
  if (!mb) return null;
  return mb === buildkitMemGb(Math.floor(totalBytes / MiB)) * 1024 ? null : mb * MiB;
}

/** Whether a linked instance's build fits: what both builders can still grow into stays within free memory less the apps' reserve. */
export function peerBuildFits(input: { totalBytes: number; availableBytes: number; meshHeadroomBytes: number; buildkitHeadroomBytes: number }): boolean {
  const reserveBytes = Math.max(BUILDKIT_SIZE.reserveMinBytes, input.totalBytes * BUILDKIT_SIZE.reserveShare);
  return input.meshHeadroomBytes + input.buildkitHeadroomBytes <= input.availableBytes - reserveBytes;
}

export async function hostMemory(): Promise<{ totalBytes: number; availableBytes: number } | null> {
  try {
    const info = parseMeminfo(await readFile("/proc/meminfo", "utf-8"));
    return info.MemTotal > 0 && info.MemAvailable >= 0 ? { totalBytes: info.MemTotal, availableBytes: info.MemAvailable } : null;
  } catch {
    return null;
  }
}

type Limits = { memory: number; memorySwap: number };

async function currentLimits(container: string): Promise<Limits | null> {
  try {
    const inspect = await dockerRequest<{ HostConfig?: { Memory?: number; MemorySwap?: number } }>(
      "GET",
      `/containers/${encodeURIComponent(container)}/json`,
      undefined,
      { timeoutMs: 5_000 },
    );
    const hc = inspect.HostConfig;
    return typeof hc?.Memory === "number" ? { memory: hc.Memory, memorySwap: hc.MemorySwap ?? 0 } : null;
  } catch {
    return null;
  }
}

const limitCache = new Map<string, { bytes: number | null; at: number }>();
const LIMIT_CACHE_MS = 10_000;

/** BuildKit's memory limit as it stands, which another process may have resized. Cached briefly, a failed read too; null when unreadable. */
export async function builderLimitBytes(container: string): Promise<number | null> {
  const hit = limitCache.get(container);
  if (hit && Date.now() - hit.at < LIMIT_CACHE_MS) return hit.bytes;
  const bytes = (await currentLimits(container))?.memory ?? null;
  limitCache.set(container, { bytes, at: Date.now() });
  return bytes;
}

const gib = (bytes: number) => `${(bytes / GiB).toFixed(1)} GiB`;

/**
 * Sets BuildKit's memory for the build about to run. Call only while nothing builds in it.
 * Returns the new limit in bytes, or null when it's pinned, unchanged or couldn't be set.
 */
export async function sizeBuildKit(
  container: string,
  opts: { builderBytes: () => Promise<number | null>; log: (line: string) => void; env?: Record<string, string | undefined> },
): Promise<number | null> {
  const host = await hostMemory();
  if (!host) return null;
  if (pinnedBuildKitMem(opts.env ?? process.env, host.totalBytes) !== null) return null;
  const current = await currentLimits(container);
  if (!current) return null;

  const size = buildkitSize({ ...host, builderBytes: (await opts.builderBytes()) ?? 0 });
  const swapChanged = (current.memorySwap > current.memory) !== (size.memorySwapBytes > size.memoryBytes);
  if (current.memory > 0 && Math.abs(current.memory - size.memoryBytes) < BUILDKIT_SIZE.stepBytes && !swapChanged) return null;

  try {
    await dockerRequest("POST", `/containers/${encodeURIComponent(container)}/update`, {
      Memory: size.memoryBytes,
      MemorySwap: size.memorySwapBytes,
    }, { timeoutMs: 15_000 });
  } catch (err) {
    opts.log(`[build] Warning: couldn't resize ${container}, building at its current limit: ${err instanceof Error ? err.message : err}`);
    return null;
  }
  limitCache.set(container, { bytes: size.memoryBytes, at: Date.now() });
  const swap = size.memorySwapBytes > size.memoryBytes ? `, and as much again in swap on this small host` : "";
  opts.log(
    size.floored
      ? `[build] Sized ${container} to ${gib(size.memoryBytes)}, its floor${swap}: the host has ${gib(host.availableBytes)} free, so apps may be squeezed during the build`
      : `[build] Sized ${container} to ${gib(size.memoryBytes)}${swap}: ${gib(host.availableBytes)} free on the host, ${gib(size.reserveBytes)} kept for apps`,
  );
  return size.memoryBytes;
}
