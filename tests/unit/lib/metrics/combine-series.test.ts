import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/metrics/ts-client", () => ({ tsRedis: { call: vi.fn() } }));

const { combineSeries } = await import("@/lib/metrics/store-container");

const S = 1000;

describe("combineSeries", () => {
  it("holds a gauge's last reading across a bucket it skipped", () => {
    const a: [number, number][] = [[0, 100], [20 * S, 100], [40 * S, 100]];
    const b: [number, number][] = [[0, 50], [40 * S, 50]];
    expect(combineSeries("memory", [a, b], 20 * S)).toEqual([
      [0, 150],
      [20 * S, 150],
      [40 * S, 150],
    ]);
  });

  it("drops a container once its last reading is too old", () => {
    const a: [number, number][] = [[0, 100], [200 * S, 100]];
    const b: [number, number][] = [[0, 50]];
    expect(combineSeries("memory", [a, b], 20 * S)).toEqual([
      [0, 150],
      [200 * S, 100],
    ]);
  });

  it("doesn't carry counter deltas into buckets they skipped", () => {
    const a: [number, number][] = [[0, 10], [20 * S, 10]];
    const b: [number, number][] = [[0, 5]];
    expect(combineSeries("networkRx", [a, b], 20 * S)).toEqual([
      [0, 15],
      [20 * S, 10],
    ]);
  });

  it("takes the max for limits", () => {
    expect(combineSeries("memoryLimit", [[[0, 1]], [[0, 3]]], 20 * S)).toEqual([[0, 3]]);
  });

  it("averages GPU utilization across containers", () => {
    expect(combineSeries("gpuUtilization", [[[0, 20]], [[0, 40]]], 20 * S)).toEqual([[0, 30]]);
  });
});
