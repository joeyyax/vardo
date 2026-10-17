import { describe, expect, it } from "vitest";
import { DAY_MS, HOUR_MS, MINUTE_MS, RANGE_SPECS, UPTIME_RANGES, bucketStarts, coverage, defaultRange, fillBuckets, parseRange, sinceLabel, trimToHistory, type Bucket } from "@/lib/uptime/core";

const NOW = Date.UTC(2026, 9, 17, 3, 25, 40);

const bucket = (start: number, up = 0, down = 0, unknown = 0): Bucket => ({ start, minutesUp: up, minutesDown: down, minutesUnknown: unknown, uptimePct: null, medianLatencyMs: null });

describe("bucketStarts", () => {
  it.each([
    ["1h", 60, MINUTE_MS],
    ["24h", 24, HOUR_MS],
    ["7d", 28, 6 * HOUR_MS],
    ["30d", 30, DAY_MS],
    ["90d", 90, DAY_MS],
  ] as const)("%s draws %i bars of %i ms, aligned, the last one holding now", (range, count, width) => {
    const starts = bucketStarts(range, NOW);
    expect(starts).toHaveLength(count);
    expect(RANGE_SPECS[range].bucketMs).toBe(width);
    expect(starts.every((s) => s % width === 0)).toBe(true);
    expect(starts.at(-1)!).toBeLessThanOrEqual(NOW);
    expect(starts.at(-1)! + width).toBeGreaterThan(NOW);
    expect(starts.slice(1).every((s, i) => s - starts[i] === width)).toBe(true);
  });

  it("keeps every range readable: 24 to 90 bars", () => {
    for (const range of UPTIME_RANGES) {
      const n = bucketStarts(range, NOW).length;
      expect(n).toBeGreaterThanOrEqual(24);
      expect(n).toBeLessThanOrEqual(90);
    }
  });
});

describe("defaultRange", () => {
  it("is the smallest preset that covers the history", () => {
    expect(defaultRange(0)).toBe("1h");
    expect(defaultRange(40 * MINUTE_MS)).toBe("1h");
    expect(defaultRange(5 * HOUR_MS)).toBe("24h");
    expect(defaultRange(DAY_MS)).toBe("24h");
    expect(defaultRange(DAY_MS + 1)).toBe("7d");
    expect(defaultRange(10 * DAY_MS)).toBe("30d");
    expect(defaultRange(45 * DAY_MS)).toBe("90d");
    expect(defaultRange(400 * DAY_MS)).toBe("90d");
  });
});

describe("parseRange", () => {
  it("accepts the presets only", () => {
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("6h")).toBeUndefined();
    expect(parseRange(null)).toBeUndefined();
  });
});

describe("fillBuckets and trimToHistory", () => {
  const starts = bucketStarts("24h", NOW);

  it("fills what the data lacks as unknown", () => {
    const filled = fillBuckets([bucket(starts[3], 60, 0, 0)], starts, HOUR_MS);
    expect(filled).toHaveLength(24);
    expect(filled[3].minutesUp).toBe(60);
    expect(filled[0]).toMatchObject({ minutesUnknown: 60, minutesUp: 0 });
  });

  it("starts the bars where a young monitor's history starts", () => {
    const filled = fillBuckets([], starts, HOUR_MS);
    const created = NOW - 5 * HOUR_MS - 25 * MINUTE_MS;
    const { buckets, since } = trimToHistory(filled, HOUR_MS, created);
    expect(since).toBe(created);
    // The hour holding the creation time is the first bar.
    expect(buckets[0].start).toBe(Math.floor(created / HOUR_MS) * HOUR_MS);
    expect(buckets).toHaveLength(6);
    expect(buckets.at(-1)).toEqual(filled.at(-1));
  });

  it("keeps every bar, and reports no 'since', when the history is longer than the range", () => {
    const filled = fillBuckets([], starts, HOUR_MS);
    expect(trimToHistory(filled, HOUR_MS, NOW - 3 * DAY_MS)).toEqual({ buckets: filled, since: null });
    expect(trimToHistory(filled, HOUR_MS, null)).toEqual({ buckets: filled, since: null });
  });

  it("works for daily bars", () => {
    const days = fillBuckets([], bucketStarts("30d", NOW), DAY_MS);
    const created = NOW - 2 * DAY_MS;
    const { buckets, since } = trimToHistory(days, DAY_MS, created);
    expect(since).toBe(created);
    expect(buckets).toHaveLength(3);
  });
});

describe("figureTiles and rangeSlots", () => {
  it("collapses the tiles a young history doesn't fill into one 'Since' tile", async () => {
    const { figureTiles } = await import("@/lib/uptime/format");
    const v = { h24: 100, d30: 99.5, d90: 99.5 };
    expect(figureTiles(NOW - 3 * HOUR_MS, NOW, v)).toEqual([{ label: expect.stringMatching(/^Uptime since Oct 17/), value: "100.00%", pending: false }]);
    expect(figureTiles(NOW - 7 * DAY_MS, NOW, v).map((t) => t.label)).toEqual(["Uptime, 24 hours", expect.stringMatching(/^Uptime since Oct 10/)]);
    expect(figureTiles(NOW - 200 * DAY_MS, NOW, v).map((t) => t.label)).toEqual(["Uptime, 24 hours", "Uptime, 30 days", "Uptime, 90 days"]);
  });

  it("names the figure in the org's zone and says what an empty one waits for", async () => {
    const { figureTiles, FIGURE_PENDING } = await import("@/lib/uptime/format");
    const created = NOW - 3 * HOUR_MS;
    const [tile] = figureTiles(created, NOW, { h24: null, d30: null, d90: null }, "America/Los_Angeles");
    const local = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).format(created);
    expect(tile).toEqual({ label: expect.stringContaining(local), value: FIGURE_PENDING, pending: true });
    expect(tile.label).toMatch(/^Uptime since /);
  });

  it("gives each range its full bar count", async () => {
    const { rangeSlots } = await import("@/lib/uptime/core");
    expect(UPTIME_RANGES.map(rangeSlots)).toEqual([60, 24, 28, 30, 90]);
  });
});

describe("since wording", () => {
  it("names the time for a history under two days and the date beyond", () => {
    const created = Date.UTC(2026, 9, 16, 22, 14);
    expect(sinceLabel(created, Date.UTC(2026, 9, 17, 3, 0))).toBe("Oct 16, 10:14 PM");
    expect(sinceLabel(created, Date.UTC(2026, 9, 17, 3, 0), "America/Los_Angeles")).toBe("Oct 16, 3:14 PM");
    expect(sinceLabel(created, Date.UTC(2026, 9, 22, 3, 0), "Asia/Tokyo")).toBe("Oct 17");
    expect(sinceLabel(created, Date.UTC(2026, 9, 22, 3, 0))).toBe("Oct 16");
  });

  it("claims the range only when the history covers it", () => {
    const created = Date.UTC(2026, 9, 16, 22, 14);
    expect(coverage(30 * DAY_MS, created, NOW, "30 days")).toEqual({ label: "since Oct 16, 10:14 PM", since: true });
    expect(coverage(30 * DAY_MS, NOW - 60 * DAY_MS, NOW, "30 days")).toEqual({ label: "30 days", since: false });
    expect(coverage(30 * DAY_MS, null, NOW, "30 days")).toEqual({ label: "30 days", since: false });
  });
});
