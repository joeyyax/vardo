import { describe, expect, it } from "vitest";
import { computeLevel, nextSteps, summarizeLevels } from "@/lib/trust/level";
import { CHECKS, type CheckId, type CheckResult, type CheckState } from "@/lib/trust/types";

function results(overrides: Partial<Record<CheckId, CheckState>> = {}, base: CheckState = "passing"): CheckResult[] {
  return CHECKS.map((c) => ({ id: c.id, state: overrides[c.id] ?? base, evidence: `${c.id} evidence`, checkedAt: new Date(0) }));
}

describe("computeLevel", () => {
  it("is Great when every check passes", () => {
    expect(computeLevel(results())).toBe("great");
  });

  it("is null when a Basic check fails", () => {
    expect(computeLevel(results({ https: "failing" }))).toBeNull();
  });

  it("stops below a level with an unknown check, as unknown never passes", () => {
    expect(computeLevel(results({ "disk-encrypted": "unknown" }))).toBe("good");
  });

  it("does not skip a failing lower level for a passing higher one", () => {
    expect(computeLevel(results({ "probe-guard": "partial" }))).toBe("basic");
  });

  it("treats a check with no result as unknown", () => {
    const missing = results().filter((r) => r.id !== "security-contact");
    expect(computeLevel(missing)).toBeNull();
  });

  it("is null with no results at all", () => {
    expect(computeLevel([])).toBeNull();
  });
});

describe("summarizeLevels", () => {
  it("counts passing checks per level", () => {
    const summary = summarizeLevels(results({ "two-step": "failing", "restore-tested": "partial" }));
    expect(summary.find((s) => s.level === "good")).toMatchObject({ passing: 4, total: 5, complete: false });
    expect(summary.find((s) => s.level === "better")).toMatchObject({ passing: 1, total: 2, complete: false });
    expect(summary.find((s) => s.level === "basic")).toMatchObject({ passing: 2, total: 2, complete: true });
  });
});

describe("nextSteps", () => {
  it("lists failing and partial checks in level order, not passing or unknown ones", () => {
    const steps = nextSteps(results({ "provider-cert": "failing", "two-step": "partial", "disk-encrypted": "unknown", https: "failing" }));
    expect(steps.map((s) => s.check.id)).toEqual(["https", "two-step", "provider-cert"]);
    expect(steps[1].state).toBe("partial");
  });

  it("uses a result's own title over the check's default", () => {
    const rows = results({ "nightly-backups": "failing" }).map((r) => (r.id === "nightly-backups" ? { ...r, fix: "Set up nightly backups" } : r));
    expect(nextSteps(rows)[0].fix).toBe("Set up nightly backups");
    expect(nextSteps(results({ "nightly-backups": "failing" }))[0].fix).toBe("Fix the failing backup jobs");
  });

  it("is empty when nothing is failing", () => {
    expect(nextSteps(results({ "disk-encrypted": "unknown" }))).toEqual([]);
  });
});
