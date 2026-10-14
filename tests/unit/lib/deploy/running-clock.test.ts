import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// While a deploy waits, its sweeper mark moves forward by the time waited, so the wait doesn't count toward the budget.

vi.mock("@/lib/redis", () => ({ redis: {} }));

import { pauseRunningClock, runningSinceKey } from "@/lib/deploy/running-clock";

const store = new Map<string, string>();
// Applies the shift script: only an existing mark moves.
const client = {
  eval: async (_script: string, _n: number, key: string, by: string) => {
    const mark = store.get(key);
    if (mark === undefined) return 0;
    store.set(key, String(Number(mark) + Number(by)));
    return 1;
  },
} as unknown as NonNullable<Parameters<typeof pauseRunningClock>[1]>["client"];

beforeEach(() => {
  store.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pauseRunningClock", () => {
  it("moves the mark forward by exactly the time waited", async () => {
    store.set(runningSinceKey("d1"), "1000");
    const wait = pauseRunningClock("d1", { client });
    await vi.advanceTimersByTimeAsync(25 * 60_000 + 3_000);
    await wait.resume();
    expect(Number(store.get(runningSinceKey("d1")))).toBe(1000 + 25 * 60_000 + 3_000);
  });

  it("stops moving the mark once the wait ends", async () => {
    store.set(runningSinceKey("d2"), "1000");
    const wait = pauseRunningClock("d2", { client });
    await vi.advanceTimersByTimeAsync(60_000);
    await wait.resume();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Number(store.get(runningSinceKey("d2")))).toBe(1000 + 60_000);
  });

  it("never creates a mark the sweeper hasn't set", async () => {
    const wait = pauseRunningClock("d3", { client });
    await vi.advanceTimersByTimeAsync(60_000);
    await wait.resume();
    expect(store.has(runningSinceKey("d3"))).toBe(false);
  });

  it("keeps a deploy waiting when Redis refuses the shift", async () => {
    const failing = { eval: async () => { throw new Error("down"); } } as unknown as typeof client;
    const wait = pauseRunningClock("d4", { client: failing });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(wait.resume()).resolves.toBeUndefined();
  });
});
