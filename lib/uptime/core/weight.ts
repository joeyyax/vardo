// Whether a check's target costs more than an uptime check needs: a large page, or a slow one.

import { SIZE_READ_BYTES } from "./checks";
import type { CheckResult } from "./types";

/** A body past this is a page, not a health endpoint. */
export const HEAVY_BYTES = 50_000;
/** A median answer slower than this is doing real work on every check. */
export const SLOW_MS = 500;
/** Answers needed before judging. */
const MIN_SAMPLES = 3;

export type Weight = {
  /** Median body size, or null when no answer carried one. */
  bytes: number | null;
  /** The size is a floor: the responses sent no length and reading stopped at the cap. */
  atLeast: boolean;
  medianMs: number;
  heavy: boolean;
  slow: boolean;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

/** The weight of passing HTTP answers, or null when there are too few or they're light and fast. Cached answers say nothing about the origin's cost. */
export function weighCheck(results: Pick<CheckResult, "ok" | "latencyMs" | "bytes" | "cache">[]): Weight | null {
  const fresh = results.filter((r) => r.ok && !r.cache);
  if (fresh.length < MIN_SAMPLES) return null;
  const sized = fresh.filter((r) => r.bytes !== undefined).map((r) => r.bytes!);
  const bytes = sized.length ? median(sized) : null;
  const medianMs = median(fresh.map((r) => r.latencyMs));
  const heavy = bytes !== null && bytes > HEAVY_BYTES;
  const slow = medianMs > SLOW_MS;
  if (!heavy && !slow) return null;
  return { bytes, atLeast: bytes === SIZE_READ_BYTES, medianMs, heavy, slow };
}
