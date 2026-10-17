import { describe, expect, it } from "vitest";
import { effectiveIntervalSec, evaluate, isDueAt, phaseOf, staggerOf, type CheckResult, type VantagePoint } from "@/lib/uptime/core";
import { cachedLookup } from "@/lib/uptime/dns-cache";

const MIN = 60_000;

describe("staggerOf", () => {
  const ids = ["local", "ext_b", "ext_a"];

  it("gives each vantage point a period of interval x N", () => {
    for (const self of ids) expect(staggerOf("mon_x", 60, ids, self).periodSec).toBe(180);
    expect(staggerOf("mon_x", 60, ["local"], "local").periodSec).toBe(60);
  });

  it("offsets each by the monitor's phase plus its place in the sorted ids", () => {
    const phase = phaseOf("mon_x", 60 * 1000);
    // Sorted: ext_a, ext_b, local.
    expect(staggerOf("mon_x", 60, ids, "ext_a").offsetMs).toBe(phase);
    expect(staggerOf("mon_x", 60, ids, "ext_b").offsetMs).toBe(phase + MIN);
    expect(staggerOf("mon_x", 60, ids, "local").offsetMs).toBe(phase + 2 * MIN);
  });

  it("doesn't depend on the order the ids come in, and counts this one even if missing", () => {
    expect(staggerOf("mon_x", 60, [...ids].reverse(), "ext_b")).toEqual(staggerOf("mon_x", 60, ids, "ext_b"));
    expect(staggerOf("mon_x", 60, ["local"], "ext_a").periodSec).toBe(120);
  });

  it("checks the monitor about once per interval across all vantage points", () => {
    const slots = ids.map((self) => staggerOf("mon_x", 60, ids, self));
    const start = 1000 * MIN;
    const runs = new Map<string, number[]>(ids.map((id) => [id, []]));
    const last = new Map<string, number | undefined>();
    for (let t = start; t < start + 30 * MIN; t += 1000) {
      ids.forEach((id, i) => {
        if (isDueAt(slots[i].periodSec * 1000, slots[i].offsetMs, last.get(id), t)) {
          runs.get(id)!.push(t);
          last.set(id, t);
        }
      });
    }
    const all = [...runs.values()].flat().sort((a, b) => a - b);
    // 30 minutes, one check a minute in all, three vantage points taking turns.
    expect(all.length).toBeGreaterThanOrEqual(29);
    expect(all.length).toBeLessThanOrEqual(34);
    for (const [, times] of runs) {
      expect(times.length).toBeLessThanOrEqual(12);
      for (let i = 2; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(3 * MIN - 1000);
    }
    // After each has run once, checks fall about a minute apart.
    for (let i = 4; i < all.length; i++) expect(all[i] - all[i - 1]).toBeLessThanOrEqual(MIN + 2000);
  });
});

describe("staleness with staggered checks", () => {
  const LOCAL: VantagePoint = { id: "local", name: "This instance", kind: "local" };
  const EXT: VantagePoint = { id: "ext", name: "jy0", kind: "external" };
  const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);
  const r = (vantageId: string, ageSec: number, ok: boolean): CheckResult => ({
    monitorId: "m",
    vantageId,
    path: vantageId === "local" ? "local" : "public",
    at: NOW - ageSec * 1000,
    ok,
    latencyMs: 50,
  });

  it("goes unknown between checks when it assumes one check per interval", () => {
    const results = [r("ext", 400, true), r("ext", 580, true)];
    expect(evaluate({ vantages: [LOCAL, EXT], results, now: NOW, intervalSec: 60 }).state).toBe("unknown");
  });

  it("holds a vantage point that checks every interval x N", () => {
    const results = [r("ext", 400, true), r("ext", 580, true)];
    const e = evaluate({ vantages: [LOCAL, EXT], results, now: NOW, intervalSec: effectiveIntervalSec(60, 3) });
    expect(e.state).toBe("up");
  });

  it("keeps each vantage point's own failure streak", () => {
    const results = [r("ext", 300, false), r("ext", 120, false), r("local", 200, true), r("local", 20, true)];
    const e = evaluate({ vantages: [LOCAL, EXT], results, now: NOW, intervalSec: effectiveIntervalSec(60, 2) });
    expect(e).toMatchObject({ state: "degraded", localOnly: false });
    expect(e.reading).toEqual({ kind: "unreachable-outside" });
  });

  it("never goes below one", () => {
    expect(effectiveIntervalSec(60, 0)).toBe(60);
    expect(effectiveIntervalSec(30, 4)).toBe(120);
  });
});

describe("dns cache", () => {
  it("resolves a host once a minute and shares the answer", async () => {
    let now = 0;
    let calls = 0;
    const lookup = cachedLookup(
      async (host) => {
        calls++;
        return [{ address: host === "a.example.com" ? "93.184.216.34" : "93.184.216.35", family: 4 }];
      },
      60_000,
      () => now,
    );
    const [one, two] = await Promise.all([lookup("a.example.com"), lookup("A.example.com")]);
    expect(one).toEqual(two);
    expect(calls).toBe(1);
    now = 59_000;
    await lookup("a.example.com");
    expect(calls).toBe(1);
    await lookup("b.example.com");
    expect(calls).toBe(2);
    now = 61_000;
    await lookup("a.example.com");
    expect(calls).toBe(3);
  });

  it("doesn't keep a failed lookup", async () => {
    let calls = 0;
    const lookup = cachedLookup(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
      return [{ address: "93.184.216.34", family: 4 }];
    });
    await expect(lookup("a.example.com")).rejects.toThrow();
    await expect(lookup("a.example.com")).resolves.toHaveLength(1);
    expect(calls).toBe(2);
  });
});
