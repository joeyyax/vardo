import { describe, it, expect } from "vitest";
import { mergePolledPoints, streamRetryMs } from "@/lib/metrics/stream-fallback";
import type { MetricsPoint } from "@/lib/metrics/types";

const pt = (timestamp: number): MetricsPoint => ({
  timestamp, cpu: 0, memory: 0, memoryLimit: 0, networkRx: 0, networkTx: 0,
  diskTotal: 0, gpuUtilization: 0, gpuMemoryUsed: 0, gpuMemoryTotal: 0, gpuTemperature: 0,
});

describe("mergePolledPoints", () => {
  it("appends only points newer than the last one held, in order", () => {
    const merged = mergePolledPoints([pt(1), pt(2)], [pt(4), pt(2), pt(3)], 0, 100);
    expect(merged.map((p) => p.timestamp)).toEqual([1, 2, 3, 4]);
  });

  it("returns the same array when nothing is new", () => {
    const prev = [pt(1), pt(2)];
    expect(mergePolledPoints(prev, [pt(1), pt(2)], 0, 100)).toBe(prev);
  });

  it("trims points outside the window and over the cap", () => {
    const merged = mergePolledPoints([pt(1), pt(5)], [pt(6), pt(7), pt(8)], 5, 3);
    expect(merged.map((p) => p.timestamp)).toEqual([6, 7, 8]);
  });

  it("seeds an empty series", () => {
    expect(mergePolledPoints([], [pt(3), pt(2)], 0, 10).map((p) => p.timestamp)).toEqual([2, 3]);
  });
});

describe("streamRetryMs", () => {
  it("doubles from 15 seconds up to 2 minutes", () => {
    expect([0, 1, 2, 3, 10].map(streamRetryMs)).toEqual([15_000, 30_000, 60_000, 120_000, 120_000]);
  });
});
