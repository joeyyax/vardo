// Level and next steps from the latest check results. Pure.

import { CHECKS, LEVELS, type CheckDef, type CheckResult, type CheckState, type Level } from "./types";

export type LevelSummary = { level: Level; passing: number; total: number; complete: boolean };

export type NextStep = { check: CheckDef; state: Exclude<CheckState, "passing">; evidence: string };

function stateOf(byId: Map<string, CheckResult>, id: string): CheckState {
  return byId.get(id)?.state ?? "unknown";
}

/** Passing checks per level, and whether each level has all of its checks passing. */
export function summarizeLevels(results: CheckResult[]): LevelSummary[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return LEVELS.map((level) => {
    const defs = CHECKS.filter((c) => c.level === level);
    const passing = defs.filter((c) => stateOf(byId, c.id) === "passing").length;
    return { level, passing, total: defs.length, complete: passing === defs.length };
  });
}

/** The highest level reached with every check at it and below passing. Null when Basic isn't complete. */
export function computeLevel(results: CheckResult[]): Level | null {
  let reached: Level | null = null;
  for (const summary of summarizeLevels(results)) {
    if (!summary.complete) break;
    reached = summary.level;
  }
  return reached;
}

/** Failing and partial checks in level order. Unknown checks have no fix to name; they show in the full list. */
export function nextSteps(results: CheckResult[]): NextStep[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  const steps: NextStep[] = [];
  for (const check of CHECKS) {
    const state = stateOf(byId, check.id);
    if (state !== "failing" && state !== "partial") continue;
    steps.push({ check, state, evidence: byId.get(check.id)?.evidence ?? "" });
  }
  return steps;
}

/** Counts per state across all checks, a missing result counting as unknown. */
export function countStates(results: CheckResult[]): Record<CheckState, number> {
  const counts: Record<CheckState, number> = { passing: 0, partial: 0, failing: 0, unknown: 0 };
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const check of CHECKS) counts[stateOf(byId, check.id)]++;
  return counts;
}
