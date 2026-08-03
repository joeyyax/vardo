import { describe, it, expect } from "vitest";
import {
  MIN_NETWORK_DOMAIN, formatRateTick, formatRateValue, hasNetworkSamples,
  networkBarPoint, networkBarPoints, networkDomain, networkTicks, niceRateCeiling,
} from "@/lib/metrics/network-chart";

const KB = 1024;
const MB = 1024 ** 2;

describe("networkBarPoint", () => {
  it("puts sent above the line and received below it", () => {
    const point = networkBarPoint({ networkTxRate: 400, networkRxRate: 900 });
    expect(point.sent).toBe(400);
    expect(point.received).toBe(-900);
  });

  it("keeps the true rate alongside the signed plot value", () => {
    const point = networkBarPoint({ networkTxRate: 400, networkRxRate: 900 });
    expect(point.sentRate).toBe(400);
    expect(point.receivedRate).toBe(900);
  });

  it("carries null through as null, never as zero", () => {
    const point = networkBarPoint({ networkTxRate: null, networkRxRate: null });
    expect(point).toEqual({ sentRate: null, receivedRate: null, sent: null, received: null });
  });

  it("distinguishes a measured zero from a missing reading", () => {
    const measured = networkBarPoint({ networkTxRate: 0, networkRxRate: 0 });
    const missing = networkBarPoint({ networkTxRate: null, networkRxRate: null });
    expect(measured.sent).toBe(0);
    expect(measured.received).toBe(-0);
    expect(missing.sent).toBeNull();
    expect(missing.received).toBeNull();
  });

  it("handles one direction missing while the other reports", () => {
    const point = networkBarPoint({ networkTxRate: 500, networkRxRate: null });
    expect(point.sent).toBe(500);
    expect(point.received).toBeNull();
  });

  it("maps a whole series index for index", () => {
    const points = networkBarPoints([
      { networkTxRate: null, networkRxRate: null },
      { networkTxRate: 10, networkRxRate: 20 },
    ]);
    expect(points).toHaveLength(2);
    expect(points[1].sent).toBe(10);
  });
});

describe("hasNetworkSamples", () => {
  it("is false when every sample is missing", () => {
    const points = networkBarPoints([
      { networkTxRate: null, networkRxRate: null },
      { networkTxRate: null, networkRxRate: null },
    ]);
    expect(hasNetworkSamples(points)).toBe(false);
  });

  it("is true for an all-zero series, which is measured idle", () => {
    const points = networkBarPoints([{ networkTxRate: 0, networkRxRate: 0 }]);
    expect(hasNetworkSamples(points)).toBe(true);
  });
});

describe("niceRateCeiling", () => {
  it("rounds up to a round figure", () => {
    expect(niceRateCeiling(3 * KB)).toBe(3 * KB);
    expect(niceRateCeiling(2.2 * KB)).toBe(2.5 * KB);
    expect(niceRateCeiling(5.9 * KB)).toBe(6 * KB);
  });

  it("stays above the value it is given", () => {
    for (const value of [40, 86, 613, 7888, 302583, 22556091]) {
      expect(niceRateCeiling(value)).toBeGreaterThanOrEqual(value);
    }
  });

  it("does not collapse below the value in the bytes-per-second range", () => {
    expect(niceRateCeiling(100)).toBe(100);
    expect(niceRateCeiling(613)).toBe(800);
  });

  it("falls back to the floor for zero and nonsense", () => {
    expect(niceRateCeiling(0)).toBe(MIN_NETWORK_DOMAIN);
    expect(niceRateCeiling(-5)).toBe(MIN_NETWORK_DOMAIN);
    expect(niceRateCeiling(Number.NaN)).toBe(MIN_NETWORK_DOMAIN);
  });
});

describe("networkDomain", () => {
  it("is symmetric so zero sits in the middle", () => {
    const points = networkBarPoints([{ networkTxRate: 3 * KB, networkRxRate: 100 }]);
    const [min, max] = networkDomain(points);
    expect(min).toBe(-max);
  });

  it("sizes to the busiest direction, whichever it is", () => {
    const sentHeavy = networkDomain(networkBarPoints([{ networkTxRate: 2 * MB, networkRxRate: 10 }]));
    const receivedHeavy = networkDomain(networkBarPoints([{ networkTxRate: 10, networkRxRate: 2 * MB }]));
    expect(sentHeavy).toEqual(receivedHeavy);
    expect(sentHeavy[1]).toBe(2 * MB);
  });

  it("ignores missing samples when finding the peak", () => {
    const points = networkBarPoints([
      { networkTxRate: null, networkRxRate: null },
      { networkTxRate: 3 * KB, networkRxRate: 0 },
    ]);
    expect(networkDomain(points)[1]).toBe(3 * KB);
  });

  it("holds the floor for an idle or empty series", () => {
    expect(networkDomain([])).toEqual([-MIN_NETWORK_DOMAIN, MIN_NETWORK_DOMAIN]);
    const idle = networkBarPoints([{ networkTxRate: 0, networkRxRate: 0 }]);
    expect(networkDomain(idle)).toEqual([-MIN_NETWORK_DOMAIN, MIN_NETWORK_DOMAIN]);
  });

  it("keeps a container idling at a few hundred bytes readable", () => {
    const points = networkBarPoints([{ networkTxRate: 8, networkRxRate: 86 }]);
    expect(networkDomain(points)[1]).toBe(MIN_NETWORK_DOMAIN);
  });
});

describe("networkTicks", () => {
  it("labels both extremes, both midpoints and the center", () => {
    expect(networkTicks(4 * KB)).toEqual([-4 * KB, -2 * KB, 0, 2 * KB, 4 * KB]);
  });
});

describe("formatRateTick", () => {
  it("never prints a negative byte rate below the line", () => {
    expect(formatRateTick(-2 * MB)).toBe(formatRateTick(2 * MB));
    expect(formatRateTick(-2 * MB)).not.toContain("-");
  });

  it("marks the center line as a bare zero", () => {
    expect(formatRateTick(0)).toBe("0");
  });
});

describe("formatRateValue", () => {
  it("reads a missing sample as absent, not idle", () => {
    expect(formatRateValue(null)).toBe("Not collected");
  });

  it("reads a measured zero as a rate", () => {
    expect(formatRateValue(0)).toBe("0 B/s");
  });

  it("drops the sign so a downward bar reads as a quantity", () => {
    expect(formatRateValue(-1536)).toBe("1.5 KB/s");
  });
});
