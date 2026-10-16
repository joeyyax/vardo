import { describe, expect, it } from "vitest";
import { bandFor, computeScore, countStates, creditOf, dailyLast, historyChanges, maxScore, nextSteps, type HistoryRun } from "@/lib/trust/score";
import { CHECKS, type CheckId, type CheckResult, type CheckState } from "@/lib/trust/types";

type Spec = CheckState | { state: CheckState; credit: number };

function results(overrides: Partial<Record<CheckId, Spec>> = {}, base: CheckState = "passing"): CheckResult[] {
  return CHECKS.map((c) => {
    const o = overrides[c.id] ?? base;
    const spec = typeof o === "string" ? { state: o } : o;
    return { id: c.id, evidence: `${c.id} evidence`, checkedAt: new Date(0), ...spec };
  });
}

const weight = (id: CheckId) => CHECKS.find((c) => c.id === id)!.weight;

describe("weights", () => {
  it("sum to 100 today and match the agreed points", () => {
    expect(maxScore()).toBe(100);
    expect(weight("nightly-backups")).toBe(15);
    expect(weight("security-contact")).toBe(5);
    expect(weight("backups-protected")).toBe(10);
  });
});

describe("creditOf", () => {
  it("is full for passing, zero for failing and unknown", () => {
    expect(creditOf({ state: "passing" })).toBe(1);
    expect(creditOf({ state: "failing", credit: 0.9 })).toBe(0);
    expect(creditOf({ state: "unknown", credit: 0.9 })).toBe(0);
    expect(creditOf(undefined)).toBe(0);
  });
  it("is the stored fraction for partial, clamped, and zero when missing", () => {
    expect(creditOf({ state: "partial", credit: 0.4 })).toBe(0.4);
    expect(creditOf({ state: "partial", credit: 7 })).toBe(1);
    expect(creditOf({ state: "partial", credit: null })).toBe(0);
    expect(creditOf({ state: "partial", credit: Number.NaN })).toBe(0);
  });
});

describe("computeScore", () => {
  it("is the maximum when every check passes, in the top band", () => {
    expect(computeScore(results())).toMatchObject({ score: 100, max: 100, unverified: 0, band: "great" });
  });

  it("gives a partial check its fraction of the weight", () => {
    const s = computeScore(results({ "nightly-backups": { state: "partial", credit: 37 / 41 } }, "failing"));
    const line = s.lines.find((l) => l.check.id === "nightly-backups")!;
    expect(line.earned).toBeCloseTo((15 * 37) / 41, 5);
    expect(s.score).toBe(14);
  });

  it("earns nothing from failing checks", () => {
    expect(computeScore(results({}, "failing")).score).toBe(0);
  });

  it("never adds an unknown check to the score and reports its points as not verified", () => {
    const all = computeScore(results());
    const s = computeScore(results({ "disk-encrypted": "unknown", "provider-cert": "unknown" }));
    expect(s.score).toBe(all.score - weight("disk-encrypted") - weight("provider-cert"));
    expect(s.unverified).toBe(20);
  });

  it("treats a check with no result as unknown", () => {
    const s = computeScore(results().filter((r) => r.id !== "https"));
    expect(s.score).toBe(85);
    expect(s.unverified).toBe(15);
  });

  it("scores nothing with no results at all", () => {
    expect(computeScore([])).toMatchObject({ score: 0, unverified: 100, band: null });
  });
});

describe("bandFor", () => {
  it("has no band below 25% of the maximum", () => {
    expect(bandFor(24, 100)).toBeNull();
  });
  it("starts each band at its share of the maximum", () => {
    expect(bandFor(25, 100)).toBe("basic");
    expect(bandFor(49, 100)).toBe("basic");
    expect(bandFor(50, 100)).toBe("good");
    expect(bandFor(74, 100)).toBe("good");
    expect(bandFor(75, 100)).toBe("better");
    expect(bandFor(89, 100)).toBe("better");
    expect(bandFor(90, 100)).toBe("great");
  });
  it("scales with the maximum, not fixed points", () => {
    expect(bandFor(50, 200)).toBe("basic");
    expect(bandFor(100, 200)).toBe("good");
    expect(bandFor(40, 40)).toBe("great");
    expect(bandFor(9, 40)).toBeNull();
    expect(bandFor(10, 40)).toBe("basic");
  });
});

describe("nextSteps", () => {
  it("lists failing and partial checks, the most points to gain first", () => {
    const steps = nextSteps(
      results({ "security-contact": "failing", "restore-tested": "failing", "two-step": { state: "partial", credit: 0.5 }, "disk-encrypted": "unknown" }),
    );
    expect(steps.map((s) => [s.check.id, s.gain])).toEqual([
      ["restore-tested", 15],
      ["security-contact", 5],
      ["two-step", 5],
    ]);
  });

  it("measures a partial check by the weight it hasn't earned", () => {
    const [step] = nextSteps(results({ "nightly-backups": { state: "partial", credit: 37 / 41 } }));
    expect(step.earned).toBeCloseTo(13.54, 2);
    expect(step.gain).toBeCloseTo(1.46, 2);
  });

  it("ranks a nearly-earned heavy check below a failing light one", () => {
    const steps = nextSteps(results({ "nightly-backups": { state: "partial", credit: 37 / 41 }, "vardo-updated": "failing" }));
    expect(steps.map((s) => s.check.id)).toEqual(["vardo-updated", "nightly-backups"]);
  });

  it("uses a result's own title over the check's default", () => {
    const rows = results({ "nightly-backups": "failing" }).map((r) => (r.id === "nightly-backups" ? { ...r, fix: "Set up nightly backups" } : r));
    expect(nextSteps(rows)[0].fix).toBe("Set up nightly backups");
    expect(nextSteps(results({ "nightly-backups": "failing" }))[0].fix).toBe("Fix the failing backup jobs");
  });

  it("is empty when nothing is failing, unknown checks excluded", () => {
    expect(nextSteps(results({ "disk-encrypted": "unknown" }))).toEqual([]);
  });
});

describe("countStates", () => {
  it("counts a missing result as unknown", () => {
    expect(countStates(results({ https: "failing" }).slice(1))).toEqual({ passing: 8, partial: 0, failing: 1, unknown: 1 });
  });
});

describe("history", () => {
  const at = (iso: string) => new Date(iso);
  const run = (iso: string, weights: Record<string, number>, score = 50): HistoryRun => ({
    ranAt: at(iso),
    score,
    max: Object.values(weights).reduce((a, b) => a + b, 0),
    weights,
  });
  const title = (id: string) => `<${id}>`;

  it("says nothing when the check set and weights are the same", () => {
    expect(historyChanges([run("2026-10-01T00:00:00Z", { a: 10 }), run("2026-10-02T00:00:00Z", { a: 10 })], title)).toEqual([]);
  });

  it("names a new check with the points it adds", () => {
    const changes = historyChanges([run("2026-10-01T00:00:00Z", { a: 10 }), run("2026-10-02T00:00:00Z", { a: 10, b: 10 })], title);
    expect(changes).toEqual([{ at: at("2026-10-02T00:00:00Z"), text: "New check: <b> (+10 possible)" }]);
  });

  it("names a removed check and a reweighted one", () => {
    const changes = historyChanges([run("2026-10-01T00:00:00Z", { a: 10, b: 5 }), run("2026-10-02T00:00:00Z", { a: 15 })], title);
    expect(changes.map((c) => c.text)).toEqual(["<a> now worth 15 points, was 10", "Removed check: <b> (-5 possible)"]);
  });

  it("compares consecutive runs in time order, whatever order they arrive in", () => {
    const changes = historyChanges(
      [run("2026-10-03T00:00:00Z", { a: 10, b: 10 }), run("2026-10-01T00:00:00Z", { a: 10 }), run("2026-10-02T00:00:00Z", { a: 10, b: 10 })],
      title,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].at).toEqual(at("2026-10-02T00:00:00Z"));
  });

  it("keeps the last run of each day", () => {
    const days = dailyLast([
      run("2026-10-01T23:00:00Z", { a: 1 }, 70),
      run("2026-10-01T02:00:00Z", { a: 1 }, 40),
      run("2026-10-02T08:00:00Z", { a: 1 }, 80),
    ]);
    expect(days.map((d) => d.score)).toEqual([70, 80]);
  });
});
