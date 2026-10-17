import { describe, it, expect } from "vitest";
import { MAX_ETA_MS, MAX_TYPICAL_MS, etaMoved, lineEtas, pooledLineEtas, slotFreeAt } from "@/lib/deploy/eta";

// The start-estimate walk: each place takes the earliest free slot for its app's typical run.

const now = Date.parse("2026-10-14T12:00:00Z");
const min = 60_000;

describe("lineEtas", () => {
  it("fills the earliest slot each time", () => {
    expect(lineEtas(now, [now + 3 * min, now], [4 * min, 2 * min, 5 * min])).toEqual([now, now + 3 * min, now + 4 * min]);
  });

  it("is null from the first place that depends on a run without history", () => {
    expect(lineEtas(now, [now], [2 * min, null, 3 * min])).toEqual([now, now + 2 * min, null]);
    expect(lineEtas(now, [null, now], [1 * min])).toEqual([null]);
    expect(lineEtas(now, [], [1 * min])).toEqual([null]);
  });

  it("caps a long typical run and drops an estimate too far out", () => {
    expect(lineEtas(now, [now], [10 * MAX_TYPICAL_MS, 0])).toEqual([now, now + MAX_TYPICAL_MS]);
    const far = Array.from({ length: MAX_ETA_MS / MAX_TYPICAL_MS + 2 }, () => MAX_TYPICAL_MS);
    expect(lineEtas(now, [now], far).at(-1)).toBeNull();
  });
});

describe("pooledLineEtas", () => {
  const here = (at: number | null) => ({ at, local: true });
  const target = (at: number | null) => ({ at, local: false });

  it("keeps a place that can't use a target's slot on this server's", () => {
    const slots = [here(now + 5 * min), target(now)];
    expect(pooledLineEtas(now, slots, [{ typicalMs: 2 * min, any: false }, { typicalMs: 2 * min, any: true }])).toEqual([now + 5 * min, now]);
    expect(pooledLineEtas(now, slots, [{ typicalMs: 2 * min, any: true }, { typicalMs: 2 * min, any: false }])).toEqual([now, now + 5 * min]);
  });

  it("is null for a place no slot can take, and goes on", () => {
    expect(pooledLineEtas(now, [target(now)], [{ typicalMs: min, any: false }, { typicalMs: min, any: true }])).toEqual([null, now]);
  });
});

describe("slotFreeAt", () => {
  it("is now for an overdue run and null without history", () => {
    expect(slotFreeAt(now, now - 10 * min, 5 * min)).toBe(now);
    expect(slotFreeAt(now, now - 2 * min, 5 * min)).toBe(now + 3 * min);
    expect(slotFreeAt(now, now, null)).toBeNull();
  });
});

describe("etaMoved", () => {
  it("moves past 30 seconds or on a change to or from none", () => {
    expect(etaMoved(new Date(now), now + 20_000)).toBe(false);
    expect(etaMoved(new Date(now).toISOString(), now + 40_000)).toBe(true);
    expect(etaMoved(null, now)).toBe(true);
    expect(etaMoved(now, null)).toBe(true);
    expect(etaMoved(null, null)).toBe(false);
  });
});
