import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", async () => ({ redis: (await import("@/tests/unit/helpers/fake-redis")).createFakeRedis() }));

import { HostSampleBuffer, hostObservations, type HostSample } from "@/lib/alerts/host";
import { diskStep, MAX_DEFER_MS, RECLAIM_COOLDOWN_MS } from "@/lib/alerts/disk-reclaim";

const MIN = 60_000;
const now = 100 * MIN;

function sample(at: number, memory: number, swap: number, disk = 50): HostSample {
  return {
    at,
    memory: { percent: memory, used: memory, total: 100 },
    swap: { percent: swap, used: swap, total: 100 },
    cpuPercent: null,
    load: null,
    disk: { percent: disk, used: disk, total: 100 },
  };
}

function observe(memory: number, swap: number) {
  const buffer = new HostSampleBuffer();
  for (let i = 20; i >= 0; i--) buffer.push(sample(now - i * MIN, memory, swap));
  return hostObservations(buffer, now, {});
}

describe("swap alert", () => {
  it("doesn't fire on heavy swap with ample memory available, as an LXC reading the hypervisor's swap", () => {
    const { evaluated, observations } = observe(30, 90);
    expect(evaluated).toContain("host.swap");
    expect(observations.find((o) => o.type === "host.swap")).toBeUndefined();
  });

  it("fires on heavy swap under memory pressure", () => {
    const swap = observe(88, 60).observations.find((o) => o.type === "host.swap");
    expect(swap?.fires).toBe(true);
    expect(swap?.item.facts).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Memory available" })]));
  });
});

describe("disk alert", () => {
  it("says what was reclaimed and what's left", () => {
    const buffer = new HostSampleBuffer();
    buffer.push(sample(now, 30, 0, 90));
    const { observations } = hostObservations(buffer, now, {
      disk: {
        reclaim: { finishedAt: new Date(now).toISOString(), freedBytes: 5 * 1024 ** 3 },
        reclaimableBytes: 2 * 1024 ** 3,
        unusedVolumes: { count: 4, bytes: 1024 ** 3 },
        topApps: [{ name: "photos", bytes: 80 * 1024 ** 3 }],
      },
    });
    const disk = observations.find((o) => o.type === "host.disk")!;
    const labels = disk.item.facts?.map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(["Already reclaimed", "Unused volumes", "Largest apps"]));
    expect(disk.item.detail).toMatch(/Still full/);
  });
});

describe("diskStep", () => {
  const base = { now, last: null, running: false, deferringSince: null };

  it("reclaims before alerting when nothing ran recently", () => {
    expect(diskStep({ ...base, percent: 90 })).toEqual({ kind: "reclaim" });
    expect(diskStep({ ...base, percent: 90, last: { finishedAt: new Date(now - RECLAIM_COOLDOWN_MS).toISOString() } })).toEqual({ kind: "reclaim" });
  });

  it("waits on a reclaim in flight, but not forever", () => {
    expect(diskStep({ ...base, percent: 90, running: true, deferringSince: now - MIN })).toEqual({ kind: "defer" });
    expect(diskStep({ ...base, percent: 90, running: true, deferringSince: now - MAX_DEFER_MS })).toEqual({ kind: "evaluate" });
  });

  it("alerts after a recent reclaim left the disk full", () => {
    expect(diskStep({ ...base, percent: 90, last: { finishedAt: new Date(now - MIN).toISOString() } })).toEqual({ kind: "evaluate" });
  });

  it("does nothing special under the line", () => {
    expect(diskStep({ ...base, percent: 50 })).toEqual({ kind: "evaluate" });
  });
});
