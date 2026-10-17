// The agreement rule. A vantage point is failing on a path after two failed checks in a row. Public external results decide a monitor;
// with none, mesh results decide; with none, the local one does. Vantage points outside the deciding set can still disagree.

import {
  isUnknownResult,
  type CheckPath,
  type CheckResult,
  type Evaluation,
  type MonitorState,
  type Reading,
  type VantagePoint,
  type VantageState,
  type VantageStatus,
} from "./types";

export const FAILURES_TO_FAIL = 2;

/** Results older than three intervals (at least 90 seconds) no longer count as current. */
export function staleAfterMs(intervalSec: number): number {
  return Math.max(90_000, intervalSec * 3 * 1000);
}

/** The path a vantage point's results take when it has none yet. */
export const defaultPath = (v: Pick<VantagePoint, "kind">): CheckPath => (v.kind === "local" ? "local" : "public");

/** One vantage point's state on one path from its results, in any order. */
export function vantageStatus(vantage: VantagePoint, results: CheckResult[], now: number, intervalSec: number, path: CheckPath = defaultPath(vantage)): VantageStatus {
  const mine = results.filter((r) => r.vantageId === vantage.id && r.path === path).sort((a, b) => b.at - a.at);
  const last = mine[0];
  if (!last || isUnknownResult(last) || now - last.at > staleAfterMs(intervalSec)) return { vantage, path, state: "unknown", last };

  const known = mine.filter((r) => !isUnknownResult(r));
  let run = 0;
  while (run < known.length && known[run].ok === last.ok) run++;
  const since = known[run - 1].at;
  const state: VantageState = !last.ok && run >= FAILURES_TO_FAIL ? "failing" : "up";
  return { vantage, path, state, last, since };
}

/** Which tier a status weighs in: public external, mesh external or local. */
export type Tier = "public" | "mesh" | "local";

export function tierOf(s: Pick<VantageStatus, "vantage" | "path">): Tier {
  if (s.vantage.kind === "local") return "local";
  return s.path === "mesh" ? "mesh" : "public";
}

const names = (list: VantageStatus[]) => [...new Set(list.map((s) => (s.vantage.kind === "local" ? "this instance" : s.vantage.name)))];

/**
 * The monitor's state across vantage points and paths.
 * - Public external results decide; without them mesh results do; without those the local one does (`localOnly`).
 * - No deciding vantage point failing is `up`; most failing is `down`; some failing is `degraded`.
 * - A mesh verdict of down with the local check passing is `degraded`: the app is up and the link or peer is the problem.
 * - A vantage point outside the deciding set that fails while the deciders are up makes it `degraded`.
 * - `reading` says which of these it is.
 */
export function evaluate(args: {
  vantages: VantagePoint[];
  results: CheckResult[];
  now: number;
  intervalSec: number;
}): Evaluation {
  const statuses: VantageStatus[] = [];
  for (const v of args.vantages) {
    const paths = new Set<CheckPath>(args.results.filter((r) => r.vantageId === v.id).map((r) => r.path));
    if (paths.size === 0) paths.add(defaultPath(v));
    for (const path of paths) statuses.push(vantageStatus(v, args.results, args.now, args.intervalSec, path));
  }

  const known = statuses.filter((s) => s.state !== "unknown");
  const tiers: Record<Tier, VantageStatus[]> = { public: [], mesh: [], local: [] };
  for (const s of known) tiers[tierOf(s)].push(s);
  const tier: Tier = tiers.public.length ? "public" : tiers.mesh.length ? "mesh" : "local";
  const deciding = tiers[tier];
  const localOnly = tier === "local";
  if (deciding.length === 0) return { state: "unknown", localOnly, vantages: statuses };

  const failing = deciding.filter((s) => s.state === "failing");
  const others = known.filter((s) => !deciding.includes(s));
  let state: MonitorState = failing.length === 0 ? "up" : failing.length * 2 > deciding.length ? "down" : "degraded";
  let reading: Reading | undefined;

  if (state === "down" && !localOnly && others.some((s) => s.state === "up")) {
    if (tier === "public") reading = { kind: "unreachable-outside" };
    else {
      state = "degraded";
      reading = { kind: "unreachable-mesh" };
    }
  } else if (state === "degraded") {
    reading = { kind: "vantage-failing", vantages: names(failing) };
  } else if (state === "up" && !localOnly) {
    const dissent = others.filter((s) => s.state === "failing");
    if (dissent.length > 0) {
      state = "degraded";
      reading = dissent.length === 1 && tierOf(dissent[0]) === "local" ? { kind: "local-only" } : { kind: "vantage-failing", vantages: names(dissent) };
    }
  }

  const downSince = state === "down" ? Math.min(...failing.map((s) => s.since ?? args.now)) : undefined;
  return {
    state,
    localOnly,
    vantages: statuses,
    ...(downSince !== undefined ? { downSince } : {}),
    ...(reading ? { reading } : {}),
  };
}
