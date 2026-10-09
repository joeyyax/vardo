import { describe, it, expect, vi } from "vitest";
import { assertSpace, InsufficientSpaceError, stagingNeed, targetNeed } from "@/lib/backups/disk-space";

const GB = 1024 ** 3;

describe("space a restore needs", () => {
  it("doubles staging for an encrypted archive: the download and its decrypted copy", () => {
    expect(stagingNeed(10 * GB, true).bytes).toBe(Math.ceil(22 * GB));
    expect(stagingNeed(10 * GB, false).bytes).toBe(Math.ceil(11 * GB));
  });

  it("needs the archive's size plus 10% at the destination", () => {
    expect(targetNeed(10 * GB).bytes).toBe(Math.ceil(11 * GB));
  });
});

describe("assertSpace", () => {
  const need = (freeBytes: number | null) => ({
    label: "staging filesystem",
    path: "/var/lib/vardo/backups-staging",
    neededBytes: 22 * GB,
    freeBytes,
    why: "the download and its decrypted copy, plus 10%",
  });

  it("refuses naming the free space and the space needed", () => {
    expect(() => assertSpace([need(5 * GB)], () => {})).toThrow(InsufficientSpaceError);
    expect(() => assertSpace([need(5 * GB)], () => {})).toThrow(
      "Not enough disk space: the staging filesystem (/var/lib/vardo/backups-staging) has 5 GB free and needs 22 GB (the download and its decrypted copy, plus 10%)",
    );
  });

  it("names every short filesystem", () => {
    const target = { ...need(1 * GB), label: "restore destination", path: "/var/lib/docker" };
    expect(() => assertSpace([need(5 * GB), target], () => {})).toThrow(/staging filesystem .*; the restore destination \(\/var\/lib\/docker\) has 1 GB free/);
  });

  it("passes with room to spare", () => {
    const log = vi.fn();
    expect(() => assertSpace([need(30 * GB)], log)).not.toThrow();
    expect(log).toHaveBeenCalledWith("Free space on the staging filesystem: 30 GB, needs 22 GB");
  });

  it("passes with a warning when free space can't be measured", () => {
    const log = vi.fn();
    expect(() => assertSpace([need(null)], log)).not.toThrow();
    expect(log.mock.calls[0][0]).toMatch(/couldn't measure free space/);
  });
});
