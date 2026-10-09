// Refuses a build or deploy when the disk behind Docker is nearly full.

import { statfs } from "fs/promises";
import { formatBytes } from "@/lib/metrics/format";
import { DeployBlockedError } from "./errors";

export const DEFAULT_MAX_USED_PERCENT = 95;
export const DEFAULT_MIN_FREE_GB = 2;

/** `usedBytes` excludes root-reserved blocks, so used plus free can fall short of total, as in df. */
export type DiskSpace = { totalBytes: number; usedBytes: number; freeBytes: number };

export type DiskGuardLimits = { maxUsedPercent: number; minFreeBytes: number };

/** Limits from VARDO_DISK_GUARD_PERCENT and VARDO_DISK_GUARD_MIN_FREE_GB. 100 and 0 turn each check off. */
export function diskGuardLimits(env: Record<string, string | undefined> = process.env): DiskGuardLimits {
  const num = (raw: string | undefined, fallback: number) => {
    const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    maxUsedPercent: Math.min(100, num(env.VARDO_DISK_GUARD_PERCENT, DEFAULT_MAX_USED_PERCENT)),
    minFreeBytes: num(env.VARDO_DISK_GUARD_MIN_FREE_GB, DEFAULT_MIN_FREE_GB) * 1024 ** 3,
  };
}

/** Why the deploy can't go ahead on this disk, or null. */
export function diskGuardProblem(space: DiskSpace, limits: DiskGuardLimits): string | null {
  const usable = space.usedBytes + space.freeBytes;
  if (usable <= 0) return null;
  const usedPercent = (space.usedBytes / usable) * 100;
  const full = limits.maxUsedPercent < 100 && usedPercent >= limits.maxUsedPercent;
  const low = space.freeBytes < limits.minFreeBytes;
  if (!full && !low) return null;
  return (
    `Couldn't deploy: the disk is ${Math.floor(usedPercent)}% full with ${formatBytes(space.freeBytes)} free ` +
    `(the limit is ${limits.maxUsedPercent}% or ${formatBytes(limits.minFreeBytes)} free).\n` +
    `Free space under Admin → Settings → Maintenance, ` +
    `or set VARDO_DISK_GUARD_PERCENT and VARDO_DISK_GUARD_MIN_FREE_GB in .env.`
  );
}

/** Free and total bytes on the console's root filesystem, which on an overlay is Docker's disk. Null when unreadable. */
export async function readDiskSpace(path = "/"): Promise<DiskSpace | null> {
  try {
    const s = await statfs(path);
    const totalBytes = Number(s.blocks) * Number(s.bsize);
    const usedBytes = (Number(s.blocks) - Number(s.bfree)) * Number(s.bsize);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    return totalBytes > 0 ? { totalBytes, usedBytes, freeBytes } : null;
  } catch {
    return null;
  }
}

/** Throws when the disk is past the guard's limits. An unreadable disk passes. */
export async function assertDiskHeadroom(
  read: () => Promise<DiskSpace | null> = readDiskSpace,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const space = await read();
  if (!space) return;
  const problem = diskGuardProblem(space, diskGuardLimits(env));
  if (problem) throw new DeployBlockedError(problem);
}
