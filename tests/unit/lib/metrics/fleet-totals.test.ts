import { describe, expect, it, vi } from "vitest";

const queryAll = vi.fn();
vi.mock("@/lib/metrics/store-container", () => ({ queryAll: (...a: unknown[]) => queryAll(...a) }));

const { getFleetTotals } = await import("@/lib/metrics/fleet-totals");

const NOW = 1_700_000_000_000;

describe("getFleetTotals", () => {
  it("takes the most recent point of each series", async () => {
    queryAll.mockImplementation((metric: string) =>
      metric === "cpu"
        ? Promise.resolve([[NOW - 60_000, 40], [NOW - 1_000, 55]])
        : Promise.resolve([[NOW - 60_000, 100], [NOW - 1_000, 200]]),
    );

    await expect(getFleetTotals(NOW)).resolves.toEqual({ cpuPercent: 55, memoryBytes: 200 });
  });

  it("only asks for the recent window, not all history", async () => {
    queryAll.mockImplementation(() => Promise.resolve([[NOW, 1]]));
    await getFleetTotals(NOW);
    const [, from, to] = queryAll.mock.calls[queryAll.mock.calls.length - 1];
    expect(to).toBe(NOW);
    expect(NOW - (from as number)).toBe(5 * 60 * 1000);
  });

  it("returns null when nothing landed in the window, so the caller can omit the card", async () => {
    queryAll.mockImplementation(() => Promise.resolve([]));
    await expect(getFleetTotals(NOW)).resolves.toBeNull();
  });

  it("returns null rather than throwing when the store is unreachable", async () => {
    queryAll.mockImplementation(() => {
      throw new Error("redis down");
    });
    const outcome = await getFleetTotals(NOW).then(
      (value) => ({ resolved: value }),
      (err) => ({ threw: String(err) }),
    );
    expect(outcome).toEqual({ resolved: null });
  });
});
