import { describe, expect, it } from "vitest";
import { DEFAULT_GUARD_RANGE, parseGuardRange, rangeBuckets, rangeLabel, rangePhrase, rangeStart } from "@/lib/probe-guard/range";
import { banStatus, categoryLine, detailsStartNote, probeCategories } from "@/lib/probe-guard/history-view";
import { guardSummary, guardSummaryParts } from "@/lib/probe-guard/summary";
import { PERMANENT_UNTIL } from "@/lib/probe-guard/permanent";

const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 86_400_000;

describe("ranges", () => {
  it("parses ?range= and defaults to 7d", () => {
    expect(DEFAULT_GUARD_RANGE).toBe("7d");
    for (const r of ["1h", "24h", "7d", "30d", "90d", "all"]) expect(parseGuardRange(r)).toBe(r);
    expect(parseGuardRange(null)).toBe("7d");
    expect(parseGuardRange("365d")).toBe("7d");
    expect(parseGuardRange("ALL")).toBe("7d");
  });

  it("starts all time at the earliest retained row, never past 90 days", () => {
    expect(rangeStart("30d", NOW).getTime()).toBe(NOW.getTime() - 30 * DAY);
    const since = new Date("2026-10-10T08:00:00Z");
    expect(rangeStart("all", NOW, since)).toEqual(since);
    expect(rangeStart("all", NOW, new Date("2025-01-01T00:00:00Z")).getTime()).toBe(NOW.getTime() - 90 * DAY);
  });

  it("labels all time with its actual start", () => {
    expect(rangeLabel("all", NOW, new Date("2026-10-10T08:00:00Z"))).toBe("All time (since Oct 10)");
    expect(rangeLabel("all", NOW, new Date("2026-07-01T00:00:00Z"))).toBe("All time (last 90 days)");
    expect(rangeLabel("30d")).toBe("30d");
  });

  it("phrases the summary for the range", () => {
    expect(rangePhrase("1h", NOW)).toBe("in the last hour");
    expect(rangePhrase("30d", NOW)).toBe("in the last 30 days");
    expect(rangePhrase("all", NOW, new Date("2026-10-10T08:00:00Z"))).toBe("since Oct 10");
    expect(guardSummary({ probes: 142, bans: 3, traps: 0 }, rangePhrase("30d", NOW))).toBe("142 probes turned away in the last 30 days, 3 IPs banned");
  });

  it("links the probe and ban counts to their sections", () => {
    const parts = guardSummaryParts({ probes: 77, bans: 15, traps: 2 }, "in the last 7 days");
    expect(parts.map((p) => p.target ?? null)).toEqual(["probed", "recent-bans", null]);
  });

  it("counts short ranges in hours and long ones in days", () => {
    expect(rangeBuckets("24h", NOW)).toEqual({ unit: "hour", count: 24 });
    expect(rangeBuckets("30d", NOW)).toEqual({ unit: "day", count: 30 });
    expect(rangeBuckets("all", NOW, new Date(NOW.getTime() - 10.5 * DAY))).toEqual({ unit: "day", count: 11 });
  });
});

describe("banStatus", () => {
  const future = new Date(NOW.getTime() + DAY);
  const past = new Date(NOW.getTime() - DAY);
  it("derives every status", () => {
    expect(banStatus({ expiresAt: future, liftedAt: null }, NOW)).toEqual({ kind: "active", label: "Active" });
    expect(banStatus({ expiresAt: past, liftedAt: null }, NOW)).toEqual({ kind: "expired", label: "Expired" });
    expect(banStatus({ expiresAt: PERMANENT_UNTIL, liftedAt: null }, NOW)).toEqual({ kind: "permanent", label: "Permanent" });
    expect(banStatus({ expiresAt: future, liftedAt: past, liftedByName: "Sam Admin" }, NOW)).toEqual({ kind: "lifted", label: "Lifted by Sam Admin" });
    expect(banStatus({ expiresAt: PERMANENT_UNTIL.toISOString(), liftedAt: past.toISOString() }, NOW).label).toBe("Lifted");
  });
});

describe("probeCategories", () => {
  const rows = [
    { path: "/.env", appId: "a1", count: 30 },
    { path: "/api/.env", appId: "a2", count: 11 },
    { path: "/_ignition/execute-solution", appId: "a1", count: 28 },
    { path: "/.ssh/id_rsa", appId: null, count: 8 },
    { path: "/nothing-known", appId: "a2", count: 2 },
    { path: null, appId: "a1", count: 5 },
  ];

  it("aggregates by rule label", () => {
    const { categories } = probeCategories(rows);
    expect(categoryLine(categories)).toBe("env files 41 · Laravel Ignition exploit (RCE) 28 · SSH keys 8 · other paths 2");
  });

  it("splits per app, busiest first", () => {
    const { byApp } = probeCategories(rows);
    expect(byApp.map((a) => [a.appId, a.total])).toEqual([["a1", 58], ["a2", 13], [null, 8]]);
    expect(byApp[1].categories).toEqual([{ label: "env files", count: 11 }, { label: "other paths", count: 2 }]);
  });
});

describe("detailsStartNote", () => {
  const firstEvent = new Date("2026-10-10T15:00:00Z");
  const days = [
    { day: "2026-10-20", count: 9 },
    { day: "2026-10-10", count: 4 },
    { day: "2026-10-08", count: 12 },
  ];

  it("explains counts from before probe events were recorded", () => {
    expect(detailsStartNote({ start: new Date(NOW.getTime() - 30 * DAY), earliestEvent: firstEvent, days })).toBe(
      "Details start Oct 10; earlier probes were only counted.",
    );
  });

  it("stays quiet once the range starts after recording began", () => {
    expect(detailsStartNote({ start: new Date(NOW.getTime() - 7 * DAY), earliestEvent: firstEvent, days })).toBeNull();
  });

  it("stays quiet when nothing was counted before recording", () => {
    expect(detailsStartNote({ start: new Date(NOW.getTime() - 30 * DAY), earliestEvent: firstEvent, days: days.slice(0, 2) })).toBeNull();
  });

  it("covers short ranges and a range with no events at all", () => {
    expect(detailsStartNote({ start: new Date(NOW.getTime() - DAY), earliestEvent: null, probes: 5, recorded: 0 })).toMatch(/only counted/);
    expect(detailsStartNote({ start: new Date(NOW.getTime() - DAY), earliestEvent: null, probes: 0, recorded: 0 })).toBeNull();
  });
});
