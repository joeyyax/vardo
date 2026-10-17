// A vantage point whose own checks mostly time out is the problem, not the targets.

import type { CheckResult } from "./types";

export const IMPAIRED_WINDOW_MS = 10 * 60_000;
export const IMPAIRED_MIN_CHECKS = 10;
export const IMPAIRED_RATIO = 0.5;

export type Tally = { vantageId: string; total: number; timeouts: number };

/** Vantage points that timed out on more than half of at least ten checks across all monitors in the window. */
export function impairedVantages(tallies: Tally[]): Set<string> {
  return new Set(tallies.filter((t) => t.total >= IMPAIRED_MIN_CHECKS && t.timeouts / t.total > IMPAIRED_RATIO).map((t) => t.vantageId));
}

/** The same, from raw results (all monitors) in the window. */
export function tally(results: CheckResult[], now: number): Tally[] {
  const by = new Map<string, Tally>();
  for (const r of results) {
    if (now - r.at > IMPAIRED_WINDOW_MS) continue;
    const t = by.get(r.vantageId) ?? { vantageId: r.vantageId, total: 0, timeouts: 0 };
    t.total++;
    if (r.error === "timeout") t.timeouts++;
    by.set(r.vantageId, t);
  }
  return [...by.values()];
}

/** Timeouts from impaired vantage points become results that say nothing about the target. */
export function markImpaired(results: CheckResult[], impaired: ReadonlySet<string>): CheckResult[] {
  if (impaired.size === 0) return results;
  return results.map((r) => (!r.ok && r.error === "timeout" && impaired.has(r.vantageId) ? { ...r, error: "blocked" as const } : r));
}
