import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { dailySeries, hourOfDay, summarizeHours, type HistoryRow } from "@/lib/metrics/history";
import { HOUR_MS, emptyHistogram, histogramBucket } from "@/lib/metrics/rollup-math";

const DAY0 = Date.UTC(2026, 9, 1);

function row(hourMs: number, overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    appId: "a",
    hour: new Date(hourMs),
    metricMinutes: 60,
    cpuAvg: 10,
    cpuPeak: 20,
    memoryAvg: 100,
    memoryPeak: 200,
    memoryLimit: 1000,
    networkRxBytes: 10,
    networkTxBytes: 5,
    checksTotal: 12,
    checksUp: 12,
    responseCount: 0,
    responseMsSum: 0,
    responseHistogram: emptyHistogram(),
    ...overrides,
  };
}

function histogramOf(ms: number, n: number): number[] {
  const h = emptyHistogram();
  h[histogramBucket(ms)] = n;
  return h;
}

describe("summarizeHours", () => {
  it("weights averages by sampled minutes and keeps the peak hour", () => {
    const rows = [
      row(DAY0, { cpuAvg: 10, metricMinutes: 60 }),
      row(DAY0 + HOUR_MS, { cpuAvg: 40, cpuPeak: 90, metricMinutes: 20 }),
    ];

    const s = summarizeHours(rows, { from: new Date(DAY0), to: new Date(DAY0 + 2 * HOUR_MS) });

    expect(s.cpu).toEqual({ avg: 17.5, peak: { value: 90, at: new Date(DAY0 + HOUR_MS) } });
    expect(s.coverage).toEqual({ minutes: 80, expectedMinutes: 120, ratio: 80 / 120 });
  });

  it("exposes gaps as coverage instead of filling them", () => {
    // 72 hours with 24 rows: Vardo down for two days.
    const rows = Array.from({ length: 24 }, (_, i) => row(DAY0 + i * HOUR_MS));

    const s = summarizeHours(rows, { from: new Date(DAY0), to: new Date(DAY0 + 72 * HOUR_MS) });

    expect(s.hours).toBe(72);
    expect(s.coverage.ratio).toBeCloseTo(1 / 3);
    expect(s.cpu?.avg).toBe(10);
    expect(s.network).toEqual({ rxBytes: 240, txBytes: 120 });
    expect(s.uptime).toEqual({ checks: 288, up: 288, ratio: 1, hoursChecked: 24 });
  });

  it("rounds the window to whole hours and ignores rows outside it", () => {
    const rows = [row(DAY0 - HOUR_MS, { cpuAvg: 99 }), row(DAY0), row(DAY0 + 2 * HOUR_MS, { cpuAvg: 99 })];

    const s = summarizeHours(rows, { from: new Date(DAY0 + 10 * 60_000), to: new Date(DAY0 + 2 * HOUR_MS + 30 * 60_000) });

    expect(s.from).toEqual(new Date(DAY0));
    expect(s.to).toEqual(new Date(DAY0 + 2 * HOUR_MS));
    expect(s.cpu?.avg).toBe(10);
  });

  it("merges response histograms across hours for p50 and p95", () => {
    const rows = [
      row(DAY0, { responseCount: 90, responseMsSum: 90 * 150, responseHistogram: histogramOf(150, 90) }),
      row(DAY0 + HOUR_MS, { responseCount: 10, responseMsSum: 10 * 2500, responseHistogram: histogramOf(2500, 10) }),
    ];

    const s = summarizeHours(rows, { from: new Date(DAY0), to: new Date(DAY0 + 2 * HOUR_MS) });

    expect(s.response).toEqual({ count: 100, mean: 385, p50: 156, p95: 2500 });
  });

  it("returns nulls, not zeros, for a window with no data", () => {
    const s = summarizeHours([], { from: new Date(DAY0), to: new Date(DAY0 + 24 * HOUR_MS) });

    expect(s).toMatchObject({ cpu: null, memory: null, network: null, uptime: null, response: null });
    expect(s.coverage.ratio).toBe(0);
  });

  it("counts check-only hours toward uptime but not coverage", () => {
    const rows = [row(DAY0, { metricMinutes: 0, cpuAvg: null, cpuPeak: null, memoryAvg: null, memoryPeak: null, networkRxBytes: null, networkTxBytes: null, checksTotal: 12, checksUp: 9 })];

    const s = summarizeHours(rows, { from: new Date(DAY0), to: new Date(DAY0 + HOUR_MS) });

    expect(s.cpu).toBeNull();
    expect(s.network).toBeNull();
    expect(s.uptime?.ratio).toBe(0.75);
  });
});

describe("hourOfDay", () => {
  it("returns 24 local-hour buckets of means per sampled hour", () => {
    const rows = [
      row(DAY0 + 14 * HOUR_MS, { cpuAvg: 10 }),
      row(DAY0 + 24 * HOUR_MS + 14 * HOUR_MS, { cpuAvg: 30 }),
      row(DAY0 + 3 * HOUR_MS, { cpuAvg: 5 }),
    ];

    const utc = hourOfDay(rows, { from: new Date(DAY0), to: new Date(DAY0 + 48 * HOUR_MS) });
    expect(utc).toHaveLength(24);
    expect(utc[14]).toMatchObject({ sampledHours: 2, cpuAvg: 20 });
    expect(utc[0]).toMatchObject({ sampledHours: 0, cpuAvg: null });

    // UTC-7 in October.
    const la = hourOfDay(rows, { from: new Date(DAY0), to: new Date(DAY0 + 48 * HOUR_MS) }, "America/Los_Angeles");
    expect(la[7]).toMatchObject({ sampledHours: 2, cpuAvg: 20 });
    expect(la[20]).toMatchObject({ sampledHours: 1, cpuAvg: 5 });
  });
});

describe("dailySeries", () => {
  it("emits every day in the window, empty days with zero coverage", () => {
    const rows = [row(DAY0 + 5 * HOUR_MS), row(DAY0 + 48 * HOUR_MS + 1 * HOUR_MS, { cpuPeak: 70 })];

    const days = dailySeries(rows, { from: new Date(DAY0), to: new Date(DAY0 + 72 * HOUR_MS) });

    expect(days.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(days[0]).toMatchObject({ cpuAvg: 10, coverage: { minutes: 60, expectedMinutes: 1440 } });
    expect(days[1]).toMatchObject({ cpuAvg: null, rxBytes: null, uptime: null, coverage: { ratio: 0 } });
    expect(days[2]).toMatchObject({ cpuPeak: 70 });
  });

  it("splits days on the zone's midnight", () => {
    const rows = [row(DAY0 + 3 * HOUR_MS)];

    const days = dailySeries(rows, { from: new Date(DAY0), to: new Date(DAY0 + 24 * HOUR_MS) }, "America/Los_Angeles");

    expect(days.map((d) => d.date)).toEqual(["2026-09-30", "2026-10-01"]);
    expect(days[0]).toMatchObject({ cpuAvg: 10, coverage: { expectedMinutes: 7 * 60 } });
  });
});
