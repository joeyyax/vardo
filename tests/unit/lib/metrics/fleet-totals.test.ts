import { describe, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("@/lib/metrics/ts-client", () => ({ tsRedis: { call: (...a: unknown[]) => call(...a) } }));

const { getFleetTotals } = await import("@/lib/metrics/fleet-totals");

const NOW = 1_700_000_000_000;

/** TS.MGET shape: [key, labels, [timestamp, value]] per series. */
function series(key: string, ts: number, value: number) {
  return [key, [], [String(ts), String(value)]];
}

describe("getFleetTotals", () => {
  it("sums every container's own latest sample, not one shared timestamp", async () => {
    call.mockImplementation((_cmd: string, _filter: string, metric: string) =>
      Promise.resolve(
        metric === "metric=cpu"
          ? [series("a", NOW - 4_000, 12), series("b", NOW - 1_000, 8)]
          : [series("a", NOW - 4_000, 500), series("b", NOW - 1_000, 300)],
      ),
    );

    await expect(getFleetTotals(NOW)).resolves.toEqual({ cpuPercent: 20, memoryBytes: 800 });
  });

  it("ignores a series whose last sample predates the window", async () => {
    call.mockImplementation((_cmd: string, _filter: string, metric: string) =>
      Promise.resolve(
        metric === "metric=memory"
          ? [series("live", NOW - 1_000, 300), series("retired", NOW - 60 * 60_000, 9_999)]
          : [],
      ),
    );

    await expect(getFleetTotals(NOW)).resolves.toEqual({ cpuPercent: 0, memoryBytes: 300 });
  });

  it("returns null when every series is stale, so the caller can omit the card", async () => {
    call.mockImplementation(() => Promise.resolve([series("old", NOW - 60 * 60_000, 5)]));
    await expect(getFleetTotals(NOW)).resolves.toBeNull();
  });

  it("returns null when the store holds nothing yet", async () => {
    call.mockImplementation(() => Promise.resolve([]));
    await expect(getFleetTotals(NOW)).resolves.toBeNull();
  });

  it("returns null rather than throwing when the store is unreachable", async () => {
    call.mockImplementation(() => {
      throw new Error("redis down");
    });
    const outcome = await getFleetTotals(NOW).then(
      (value) => ({ resolved: value }),
      (err) => ({ threw: String(err) }),
    );
    expect(outcome).toEqual({ resolved: null });
  });
});
