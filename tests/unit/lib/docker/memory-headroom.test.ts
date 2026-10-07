// ---------------------------------------------------------------------------
// Figures are the live homelab host on 2026-08-03: a 24 GiB memory cgroup with
// 16.2 GiB of container working sets, which the kernel reported as 7.4 GiB
// available. Vardo's own sum lands 0.4 GiB optimistic of that, inside the
// reserve.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const host = vi.hoisted(() => ({
  getSystemInfo: vi.fn(),
  isMetricsEnabled: vi.fn(),
  getFleetTotals: vi.fn(),
  getAppResources: vi.fn(),
}));

vi.mock("@/lib/docker/client", () => ({ getSystemInfo: host.getSystemInfo }));
vi.mock("@/lib/metrics/config", () => ({ isMetricsEnabled: host.isMetricsEnabled }));
vi.mock("@/lib/metrics/fleet-totals", () => ({ getFleetTotals: host.getFleetTotals }));
vi.mock("@/lib/metrics/resources-query", () => ({ getAppResources: host.getAppResources }));

import {
  METRICS_READ_TIMEOUT_MS,
  MIN_OVERLAP_RESERVE,
  overlapFits,
  overlapFitsNow,
  overlapReserve,
  readMemory,
  type MemoryReading,
} from "@/lib/docker/memory-headroom";

const GIB = 1024 ** 3;
const HOST_TOTAL = 24 * GIB;
const FLEET_USED = 16.2 * GIB;

function reading(over: Partial<MemoryReading> = {}): MemoryReading {
  return {
    hostTotalBytes: HOST_TOTAL,
    fleetUsedBytes: FLEET_USED,
    appFootprintBytes: 41 * 1024 * 1024,
    ...over,
  };
}

describe("overlapReserve", () => {
  it("holds back a tenth of a large host", () => {
    expect(overlapReserve(HOST_TOTAL)).toBeCloseTo(2.4 * GIB, -6);
  });

  it("never falls below the floor on a small host", () => {
    expect(overlapReserve(4 * GIB)).toBe(MIN_OVERLAP_RESERVE);
  });
});

describe("overlapFits", () => {
  it("overlaps a small app on this host", () => {
    const verdict = overlapFits(reading());
    expect(verdict.fits).toBe(true);
    expect(verdict.headroomBytes).toBeCloseTo(7.76 * GIB, -6);
  });

  it("overlaps the largest app on this host, narrowly", () => {
    // scrypted, 4.27 GiB: 3.5 GiB would be left against a 2.4 GiB reserve.
    expect(overlapFits(reading({ appFootprintBytes: 4.27 * GIB })).fits).toBe(true);
  });

  it("stops first once the second copy would eat into the reserve", () => {
    expect(overlapFits(reading({ appFootprintBytes: 6 * GIB })).fits).toBe(false);
  });

  it("stops first when the app alone would not fit", () => {
    expect(overlapFits(reading({ appFootprintBytes: 9 * GIB })).fits).toBe(false);
  });

  it("reports the headroom it decided on", () => {
    const verdict = overlapFits(reading({ appFootprintBytes: 6 * GIB }));
    expect(verdict.headroomBytes).toBeCloseTo(1.8 * GIB, -6);
    expect(verdict.reserveBytes).toBeCloseTo(2.4 * GIB, -6);
  });
});

describe("overlapFits — incomplete readings fall open", () => {
  it("overlaps when nothing collects container memory", () => {
    expect(overlapFits(reading({ fleetUsedBytes: null }))).toMatchObject({
      fits: true,
      headroomBytes: null,
    });
  });

  it("overlaps when the app has no footprint yet", () => {
    expect(overlapFits(reading({ appFootprintBytes: null })).fits).toBe(true);
  });

  it("overlaps when Docker did not answer for the host", () => {
    expect(overlapFits(reading({ hostTotalBytes: null })).fits).toBe(true);
    expect(overlapFits(reading({ hostTotalBytes: 0 })).fits).toBe(true);
  });
});

describe("overlapFitsNow — an unreachable metrics store", () => {
  const never = () => new Promise<never>(() => {});

  beforeEach(() => {
    vi.useFakeTimers();
    host.getSystemInfo.mockReset().mockResolvedValue({ memoryTotal: HOST_TOTAL });
    host.isMetricsEnabled.mockReset().mockReturnValue(true);
    host.getFleetTotals.mockReset().mockImplementation(never);
    host.getAppResources.mockReset().mockImplementation(never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("overlaps once the bound passes instead of waiting on Redis", async () => {
    let verdict: boolean | undefined;
    void overlapFitsNow("org", "app", () => {}).then((v) => (verdict = v));

    await vi.advanceTimersByTimeAsync(METRICS_READ_TIMEOUT_MS);
    expect(verdict).toBe(true);
  });

  it("leaves the store alone when metrics are off", async () => {
    host.isMetricsEnabled.mockReturnValue(false);
    host.getAppResources.mockResolvedValue(null);

    expect(await readMemory("org", "app")).toMatchObject({ fleetUsedBytes: null });
    expect(host.getFleetTotals).not.toHaveBeenCalled();
  });

  it("reads nothing else when Docker did not answer for the host", async () => {
    host.getSystemInfo.mockRejectedValue(new Error("socket"));

    expect(await readMemory("org", "app")).toEqual({
      hostTotalBytes: null,
      fleetUsedBytes: null,
      appFootprintBytes: null,
    });
    expect(host.getFleetTotals).not.toHaveBeenCalled();
    expect(host.getAppResources).not.toHaveBeenCalled();
  });
});
