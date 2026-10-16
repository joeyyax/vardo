// Score, band and next steps from the latest check results. Pure.

import { BANDS, CHECKS, type Band, type CheckDef, type CheckResult, type CheckState } from "./types";

export type Weights = Record<string, number>;

export type ScoreLine = { check: CheckDef; state: CheckState; earned: number };

export type Score = {
  /** Whole points earned. */
  score: number;
  max: number;
  /** Points on checks Vardo couldn't verify. They earn nothing. */
  unverified: number;
  band: Band | null;
  lines: ScoreLine[];
};

export type NextStep = { check: CheckDef; fix: string; state: "failing" | "partial"; evidence: string; earned: number; gain: number };

/** The share of a check's weight a result earns. Only a passing or partial result earns anything. */
export function creditOf(result: Pick<CheckResult, "state" | "credit"> | undefined): number {
  if (!result) return 0;
  if (result.state === "passing") return 1;
  if (result.state !== "partial") return 0;
  const credit = result.credit ?? 0;
  return Number.isFinite(credit) ? Math.min(1, Math.max(0, credit)) : 0;
}

export function maxScore(checks: Pick<CheckDef, "weight">[] = CHECKS): number {
  return checks.reduce((sum, c) => sum + c.weight, 0);
}

/** The highest band whose share of the maximum the score reaches. Null below the first. */
export function bandFor(score: number, max: number): Band | null {
  let reached: Band | null = null;
  for (const { band, share } of BANDS) if (score >= max * share) reached = band;
  return reached;
}

export function weightsOf(checks: Pick<CheckDef, "id" | "weight">[] = CHECKS): Weights {
  return Object.fromEntries(checks.map((c) => [c.id, c.weight]));
}

export function computeScore(results: CheckResult[]): Score {
  const byId = new Map(results.map((r) => [r.id, r]));
  const lines = CHECKS.map((check): ScoreLine => {
    const r = byId.get(check.id);
    return { check, state: r?.state ?? "unknown", earned: check.weight * creditOf(r) };
  });
  const score = Math.round(lines.reduce((sum, l) => sum + l.earned, 0));
  const max = maxScore();
  const unverified = lines.filter((l) => l.state === "unknown").reduce((sum, l) => sum + l.check.weight, 0);
  return { score, max, unverified, band: bandFor(score, max), lines };
}

/** Failing and partial checks, the most points to gain first. Unknown checks have no fix to name; they show in the full list. */
export function nextSteps(results: CheckResult[]): NextStep[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  const steps: NextStep[] = [];
  for (const check of CHECKS) {
    const result = byId.get(check.id);
    if (result?.state !== "failing" && result?.state !== "partial") continue;
    const earned = check.weight * creditOf(result);
    steps.push({ check, fix: result.fix ?? check.fix, state: result.state, evidence: result.evidence, earned, gain: check.weight - earned });
  }
  return steps.sort((a, b) => b.gain - a.gain);
}

/** Counts per state across all checks, a missing result counting as unknown. */
export function countStates(results: CheckResult[]): Record<CheckState, number> {
  const counts: Record<CheckState, number> = { passing: 0, partial: 0, failing: 0, unknown: 0 };
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const check of CHECKS) counts[byId.get(check.id)?.state ?? "unknown"]++;
  return counts;
}

export type HistoryRun = { ranAt: Date; score: number; max: number; weights: Weights };
export type HistoryChange = { at: Date; text: string };

/** One line per check added, removed or reweighted between consecutive runs. */
export function historyChanges(runs: HistoryRun[], titleOf: (id: string) => string): HistoryChange[] {
  const sorted = [...runs].sort((a, b) => a.ranAt.getTime() - b.ranAt.getTime());
  const out: HistoryChange[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].weights;
    const next = sorted[i].weights;
    const at = sorted[i].ranAt;
    for (const [id, w] of Object.entries(next)) {
      if (!(id in prev)) out.push({ at, text: `New check: ${titleOf(id)} (+${w} possible)` });
      else if (prev[id] !== w) out.push({ at, text: `${titleOf(id)} now worth ${w} points, was ${prev[id]}` });
    }
    for (const [id, w] of Object.entries(prev)) {
      if (!(id in next)) out.push({ at, text: `Removed check: ${titleOf(id)} (-${w} possible)` });
    }
  }
  return out;
}

/** The last run of each UTC day, oldest first. */
export function dailyLast(runs: HistoryRun[]): HistoryRun[] {
  const byDay = new Map<string, HistoryRun>();
  for (const run of [...runs].sort((a, b) => a.ranAt.getTime() - b.ranAt.getTime())) byDay.set(run.ranAt.toISOString().slice(0, 10), run);
  return [...byDay.values()];
}
