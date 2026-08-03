import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";

const ID = "00ebd1bf8075d6dd1da83a4a6625a334beeb0dab1a62ca738db8997b35be6aa5";
const KEY = `/system.slice/docker-${ID}.scope`;

type Disk = {
  has_filesystem: boolean;
  filesystem?: { device: string; usage: number; capacity: number }[];
  has_diskio: boolean;
  diskio?: Record<string, unknown>;
};

function stats(disk: Disk) {
  const base = {
    has_cpu: true,
    cpu: { usage: { total: 0 } },
    has_memory: true,
    memory: { usage: 0, working_set: 0 },
    has_network: false,
    ...disk,
  };
  return {
    [KEY]: [
      { ...base, timestamp: "2026-01-01T00:00:00Z" },
      { ...base, timestamp: "2026-01-01T00:00:05Z" },
    ],
  };
}

function mockCadvisor(disk: Disk) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes("/spec")
          ? { [KEY]: { aliases: ["ntfy-1"], labels: { "vardo.project": "ntfy" }, memory: { limit: 0 } } }
          : stats(disk),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// cAdvisor on a cgroup v2 host reports has_filesystem false and a diskio block
// holding only pressure stalls. Reading either as 0 is what made "not measured"
// render as "using no disk".
describe("fetchAllContainerMetrics — disk absence", () => {
  it("reports no filesystem stats as null, not zero", async () => {
    mockCadvisor({ has_filesystem: false, has_diskio: true, diskio: { psi: {} } });

    const [m] = await fetchAllContainerMetrics("http://cadvisor.test/no-fs");

    expect(m.diskUsage).toBeNull();
    expect(m.diskLimit).toBeNull();
  });

  it("reports a diskio block without io_service_bytes as null, not zero", async () => {
    mockCadvisor({ has_filesystem: false, has_diskio: true, diskio: { psi: {} } });

    const [m] = await fetchAllContainerMetrics("http://cadvisor.test/psi-only");

    expect(m.diskWriteBytes).toBeNull();
  });

  it("keeps a real zero when the counters are reported", async () => {
    mockCadvisor({
      has_filesystem: true,
      filesystem: [{ device: "/dev/sda1", usage: 0, capacity: 100 }],
      has_diskio: true,
      diskio: { io_service_bytes: [{ device: "/dev/sda", major: 8, minor: 0, stats: { Write: 0 } }] },
    });

    const [m] = await fetchAllContainerMetrics("http://cadvisor.test/real-zero");

    expect(m.diskUsage).toBe(0);
    expect(m.diskLimit).toBe(100);
    expect(m.diskWriteBytes).toBe(0);
  });

  it("sums the filesystems it is given", async () => {
    mockCadvisor({
      has_filesystem: true,
      filesystem: [
        { device: "/dev/sda1", usage: 200, capacity: 1000 },
        { device: "/dev/sdb1", usage: 300, capacity: 2000 },
      ],
      has_diskio: false,
    });

    const [m] = await fetchAllContainerMetrics("http://cadvisor.test/two-fs");

    expect(m.diskUsage).toBe(500);
    expect(m.diskLimit).toBe(3000);
  });
});
