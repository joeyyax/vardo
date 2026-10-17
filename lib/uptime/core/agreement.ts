// The agreement rule: a vantage point is failing after two failed checks in a row; a monitor is down when most external vantage points are failing.

import { isUnknownResult, type CheckResult, type Evaluation, type MonitorState, type VantagePoint, type VantageState, type VantageStatus } from "./types";

export const FAILURES_TO_FAIL = 2;

/** Results older than three intervals (at least 90 seconds) no longer count as current. */
export function staleAfterMs(intervalSec: number): number {
  return Math.max(90_000, intervalSec * 3 * 1000);
}

/** One vantage point's state from its results, in any order. */
export function vantageStatus(vantage: VantagePoint, results: CheckResult[], now: number, intervalSec: number): VantageStatus {
  const mine = results.filter((r) => r.vantageId === vantage.id).sort((a, b) => b.at - a.at);
  const last = mine[0];
  if (!last || isUnknownResult(last) || now - last.at > staleAfterMs(intervalSec)) return { vantage, state: "unknown", last };

  const known = mine.filter((r) => !isUnknownResult(r));
  let run = 0;
  while (run < known.length && known[run].ok === last.ok) run++;
  const since = known[run - 1].at;
  const state: VantageState = !last.ok && run >= FAILURES_TO_FAIL ? "failing" : "up";
  return { vantage, state, last, since };
}

/**
 * The monitor's state across vantage points. External vantage points decide when any has current data;
 * otherwise the local one does and the evaluation is flagged `localOnly`.
 */
export function evaluate(args: {
  vantages: VantagePoint[];
  results: CheckResult[];
  now: number;
  intervalSec: number;
}): Evaluation {
  const statuses = args.vantages.map((v) => vantageStatus(v, args.results, args.now, args.intervalSec));
  const known = (s: VantageStatus) => s.state !== "unknown";
  const externals = statuses.filter((s) => s.vantage.kind === "external" && known(s));

  const localOnly = externals.length === 0;
  const deciding = localOnly ? statuses.filter((s) => s.vantage.kind === "local" && known(s)) : externals;
  if (deciding.length === 0) return { state: "unknown", localOnly, vantages: statuses };

  const failing = deciding.filter((s) => s.state === "failing");
  const state: MonitorState = failing.length * 2 > deciding.length ? "down" : "up";
  const downSince = state === "down" ? Math.min(...failing.map((s) => s.since ?? args.now)) : undefined;
  return { state, localOnly, vantages: statuses, ...(downSince !== undefined ? { downSince } : {}) };
}
