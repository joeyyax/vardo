import { describe, it, expect } from "vitest";
import {
  assertDiskHeadroom,
  diskGuardLimits,
  diskGuardProblem,
  readDiskSpace,
} from "@/lib/docker/disk-guard";
import { DeployBlockedError } from "@/lib/docker/errors";

const GB = 1024 ** 3;
const disk = (totalGb: number, freeGb: number) => ({
  totalBytes: totalGb * GB,
  usedBytes: (totalGb - freeGb) * GB,
  freeBytes: freeGb * GB,
});
const defaults = diskGuardLimits({});

describe("diskGuardLimits", () => {
  it("defaults to 95% or 2 GB free", () => {
    expect(defaults).toEqual({ maxUsedPercent: 95, minFreeBytes: 2 * GB });
  });

  it("reads both env overrides and ignores junk", () => {
    expect(diskGuardLimits({ VARDO_DISK_GUARD_PERCENT: "98", VARDO_DISK_GUARD_MIN_FREE_GB: "0.5" })).toEqual({
      maxUsedPercent: 98,
      minFreeBytes: 0.5 * GB,
    });
    expect(diskGuardLimits({ VARDO_DISK_GUARD_PERCENT: "lots", VARDO_DISK_GUARD_MIN_FREE_GB: "-1" })).toEqual(defaults);
  });
});

describe("diskGuardProblem", () => {
  it("passes a disk with room", () => {
    expect(diskGuardProblem(disk(100, 20), defaults)).toBeNull();
  });

  it("refuses at 95% used", () => {
    expect(diskGuardProblem(disk(1000, 40), defaults)).toMatch(/96% full/);
  });

  it("refuses under 2 GB free on a small disk", () => {
    expect(diskGuardProblem(disk(20, 1.5), defaults)).toMatch(/1\.5 GB free/);
  });

  it("names the overrides", () => {
    expect(diskGuardProblem(disk(20, 0.5), defaults)).toMatch(/VARDO_DISK_GUARD_PERCENT and VARDO_DISK_GUARD_MIN_FREE_GB/);
  });

  it("turns off with 100 and 0", () => {
    expect(diskGuardProblem(disk(20, 0.1), { maxUsedPercent: 100, minFreeBytes: 0 })).toBeNull();
  });
});

describe("assertDiskHeadroom", () => {
  it("throws DeployBlockedError on a full disk", async () => {
    await expect(assertDiskHeadroom(async () => disk(100, 1), {})).rejects.toBeInstanceOf(DeployBlockedError);
  });

  it("passes when the disk can't be read", async () => {
    await expect(assertDiskHeadroom(async () => null, {})).resolves.toBeUndefined();
  });

  it("reads a real filesystem", async () => {
    const space = await readDiskSpace("/");
    expect(space?.totalBytes).toBeGreaterThan(0);
    expect(space!.usedBytes + space!.freeBytes).toBeLessThanOrEqual(space!.totalBytes);
  });
});
