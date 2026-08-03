// ---------------------------------------------------------------------------
// The live homelab host booted 2026-07-27 14:05:59 and read oom_kill 171 on
// 2026-08-03 — 6.85 days, a shade under 25 kills a day, or one an hour. That
// rate is what rules out an event per kill.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import { killsPerDay, oomDelta, oomWindowSummary } from "@/lib/docker/oom-watch";

const HOUR_MS = 60 * 60_000;

describe("oomDelta", () => {
  it("counts nothing on the first reading, which has no baseline", () => {
    expect(oomDelta(null, 171)).toBe(0);
  });

  it("counts the rise between two readings", () => {
    expect(oomDelta(165, 171)).toBe(6);
  });

  it("counts nothing when the counter held still", () => {
    expect(oomDelta(171, 171)).toBe(0);
  });

  it("treats a counter that went backwards as a reboot, not a negative", () => {
    expect(oomDelta(171, 2)).toBe(2);
  });
});

describe("killsPerDay", () => {
  it("reads one an hour as roughly the observed daily rate", () => {
    expect(Math.round(killsPerDay(1, HOUR_MS))).toBe(24);
  });

  it("matches the host's own week when given the whole span", () => {
    expect(Math.round(killsPerDay(171, 6.85 * 86_400_000))).toBe(25);
  });

  it("does not divide by a zero window", () => {
    expect(killsPerDay(5, 0)).toBe(0);
  });
});

describe("oomWindowSummary", () => {
  it("leads with the count and the rate it implies", () => {
    expect(oomWindowSummary(1, HOUR_MS, [])).toContain("1 OOM kill(s)");
    expect(oomWindowSummary(1, HOUR_MS, [])).toContain("~24/day");
  });

  it("names the container when a kill could be attributed", () => {
    const summary = oomWindowSummary(3, HOUR_MS, [
      { containerName: "browser-mcp-production-green-browser-mcp-1", kills: 1 },
    ]);
    expect(summary).toContain("1 attributed: browser-mcp-production-green-browser-mcp-1 (1)");
  });

  it("says plainly that the rest cannot be attributed", () => {
    const summary = oomWindowSummary(3, HOUR_MS, [
      { containerName: "browser-mcp-production-green-browser-mcp-1", kills: 1 },
    ]);
    expect(summary).toContain("2 in cgroups that no longer exist");
  });

  it("does not claim an unattributed remainder when every kill was named", () => {
    const summary = oomWindowSummary(2, HOUR_MS, [{ containerName: "app-1", kills: 2 }]);
    expect(summary).not.toContain("no longer exist");
  });

  it("reports an aggregate that moved with nothing to pin it on", () => {
    const summary = oomWindowSummary(24, HOUR_MS, []);
    expect(summary).not.toContain("attributed:");
    expect(summary).toContain("24 in cgroups that no longer exist");
  });
});
