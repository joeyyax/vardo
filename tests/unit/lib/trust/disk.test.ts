import { describe, expect, it } from "vitest";
import { judgeDiskEncryption, kernelName, mountFor, parseMountTable, type Sys } from "@/lib/trust/disk";

/** A sysfs fixture: block devices with an optional dm name, dm uuid and slaves. */
type Dev = { name?: string; uuid?: string; slaves?: string[] };

function tree(devs: Record<string, Dev>): Sys {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  dirs.set("/sys/class/block", Object.keys(devs));
  for (const [dev, d] of Object.entries(devs)) {
    dirs.set(`/sys/class/block/${dev}`, [...(d.slaves ? ["slaves"] : []), ...(d.uuid ? ["dm"] : [])]);
    if (d.name !== undefined) files.set(`/sys/class/block/${dev}/dm/name`, d.name);
    if (d.uuid !== undefined) files.set(`/sys/class/block/${dev}/dm/uuid`, d.uuid);
    if (d.slaves) dirs.set(`/sys/class/block/${dev}/slaves`, d.slaves);
  }
  return { read: (p) => files.get(p) ?? null, list: (p) => dirs.get(p) ?? null };
}

const mountsOn = (source: string, target = "/", fstype = "ext4") =>
  `proc /proc proc rw 0 0\n${source} ${target} ${fstype} rw 0 0\ntmpfs /run tmpfs rw 0 0\n`;

describe("parseMountTable and mountFor", () => {
  it("picks the longest covering mount and unescapes spaces", () => {
    const mounts = parseMountTable("/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /var/lib/docker ext4 rw 0 0\n/dev/sdc1 /data\\040disk xfs rw 0 0\n");
    expect(mountFor("/var/lib/docker", mounts)?.source).toBe("/dev/sdb1");
    expect(mountFor("/var/lib/docker/volumes", mounts)?.source).toBe("/dev/sdb1");
    expect(mountFor("/var/lib/dockerish", mounts)?.source).toBe("/dev/sda1");
    expect(mountFor("/data disk/x", mounts)?.source).toBe("/dev/sdc1");
  });
});

describe("kernelName", () => {
  const sys = tree({ "dm-0": { name: "vg-root", uuid: "LVM-abc" }, sda: {}, sda1: {} });
  it("maps mapper, LVM and plain device paths", () => {
    expect(kernelName("/dev/mapper/vg-root", sys)).toBe("dm-0");
    expect(kernelName("/dev/vg/root", sys)).toBe("dm-0");
    expect(kernelName("/dev/sda1", sys)).toBe("sda1");
  });
  it("returns null for a device it can't find", () => {
    expect(kernelName("/dev/mapper/other", sys)).toBeNull();
    expect(kernelName("/dev/sdz9", sys)).toBeNull();
  });
});

describe("judgeDiskEncryption", () => {
  const dataRoot = "/var/lib/docker";

  it("passes when the root is a LUKS mapping", () => {
    const sys = tree({ "dm-0": { name: "cryptroot", uuid: "CRYPT-LUKS2-1234-cryptroot", slaves: ["sda3"] }, sda3: {} });
    const j = judgeDiskEncryption({ mounts: mountsOn("/dev/mapper/cryptroot"), dataRoot, sys });
    expect(j.state).toBe("passing");
    expect(j.evidence).toContain("LUKS");
  });

  it("passes for LVM on top of LUKS", () => {
    const sys = tree({
      "dm-0": { name: "vg-root", uuid: "LVM-abc", slaves: ["dm-1"] },
      "dm-1": { name: "cryptlvm", uuid: "CRYPT-LUKS2-9-cryptlvm", slaves: ["nvme0n1p3"] },
      nvme0n1p3: {},
    });
    expect(judgeDiskEncryption({ mounts: mountsOn("/dev/mapper/vg-root"), dataRoot, sys }).state).toBe("passing");
  });

  it("follows a separate data-root mount, not /", () => {
    const sys = tree({ sda1: {}, "dm-0": { name: "data", uuid: "CRYPT-LUKS2-1-data", slaves: ["sdb1"] }, sdb1: {} });
    const mounts = `/dev/sda1 / ext4 rw 0 0\n/dev/mapper/data ${dataRoot} ext4 rw 0 0\n`;
    expect(judgeDiskEncryption({ mounts, dataRoot, sys }).state).toBe("passing");
  });

  it("fails when the device chain is visible and has no LUKS", () => {
    const sys = tree({ sda1: {}, sda: {} });
    const j = judgeDiskEncryption({ mounts: mountsOn("/dev/sda1"), dataRoot, sys });
    expect(j.state).toBe("failing");
    expect(j.evidence).toContain("no LUKS layer");
  });

  it("fails for plain LVM over an unencrypted disk", () => {
    const sys = tree({ "dm-0": { name: "vg-root", uuid: "LVM-abc", slaves: ["sda2"] }, sda2: {} });
    expect(judgeDiskEncryption({ mounts: mountsOn("/dev/mapper/vg-root"), dataRoot, sys }).state).toBe("failing");
  });

  it("is unknown when only some backing devices are encrypted", () => {
    const sys = tree({
      md0: { slaves: ["dm-0", "sdb1"] },
      "dm-0": { name: "c", uuid: "CRYPT-LUKS2-1-c", slaves: ["sda1"] },
      sda1: {},
      sdb1: {},
    });
    expect(judgeDiskEncryption({ mounts: mountsOn("/dev/md0"), dataRoot, sys }).state).toBe("unknown");
  });

  it("is unknown when the host mount table can't be read", () => {
    const j = judgeDiskEncryption({ mounts: null, dataRoot, sys: tree({}) });
    expect(j.state).toBe("unknown");
    expect(j.evidence).toContain("mount table");
  });

  it("is unknown when the host's /sys isn't visible", () => {
    const j = judgeDiskEncryption({ mounts: mountsOn("/dev/sda1"), dataRoot, sys: { read: () => null, list: () => null } });
    expect(j.state).toBe("unknown");
    expect(j.evidence).toContain("/sys");
  });

  it("is unknown for a root that isn't a block device", () => {
    const j = judgeDiskEncryption({ mounts: mountsOn("overlay", "/", "overlay"), dataRoot, sys: tree({ sda: {} }) });
    expect(j.state).toBe("unknown");
    expect(j.evidence).toContain("overlay");
  });

  it("is unknown when the device can't be mapped", () => {
    const j = judgeDiskEncryption({ mounts: mountsOn("/dev/mapper/ghost"), dataRoot, sys: tree({ sda: {} }) });
    expect(j.state).toBe("unknown");
  });
});
