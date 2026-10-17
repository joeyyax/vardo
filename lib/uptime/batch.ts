// What the owner accepts in a delivered batch of results.

import { DAY_MS, type CheckResult } from "./core";
import { MAX_RESULTS_PER_RECORD } from "./link";

/** Results older than this, or further ahead than the skew, are refused. */
const MAX_AGE_MS = 14 * DAY_MS;
const MAX_SKEW_MS = 5 * 60_000;

/**
 * The reason a batch can't be stored, or null. Every result must be this vantage point's, for a monitor it watches, within retention,
 * on the public path. A result with no path predates paths and counts as public.
 */
export function checkWatchedBatch(
  results: CheckResult[],
  remoteId: string,
  watching: Set<string>,
  now: number,
): string | null {
  if (!Array.isArray(results) || results.length === 0) return "empty batch";
  if (results.length > MAX_RESULTS_PER_RECORD) return "batch too large";
  for (const r of results) {
    if (!watching.has(r.monitorId)) return "monitor not watched";
    if (r.vantageId !== remoteId) return "wrong vantage point";
    if ((r as Partial<CheckResult>).path !== undefined && r.path !== "public") return "wrong path";
    if (!Number.isFinite(r.at) || r.at < now - MAX_AGE_MS || r.at > now + MAX_SKEW_MS) return "timestamp out of range";
    if (typeof r.ok !== "boolean" || !Number.isInteger(r.latencyMs) || r.latencyMs < 0) return "malformed result";
  }
  return null;
}
