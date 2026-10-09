export type Summary = {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
};

/** Nearest-rank percentile of an ascending array. Null when empty. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarize(values: number[]): Summary {
  if (values.length === 0) {
    return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

export type Outcome = "ok" | "limited" | "error";

export type RequestStats = {
  requests: number;
  ok: number;
  limited: number;
  errors: number;
  errorRate: number;
  rps: number;
  latency: Summary;
};

/** Latency covers successful requests only. Rate-limited (429) responses count apart from errors. */
export function requestStats(
  samples: { ms: number; outcome: Outcome }[],
  elapsedMs: number,
): RequestStats {
  const ok = samples.filter((s) => s.outcome === "ok");
  const limited = samples.filter((s) => s.outcome === "limited").length;
  const errors = samples.filter((s) => s.outcome === "error").length;
  const attempted = samples.length - limited;
  return {
    requests: samples.length,
    ok: ok.length,
    limited,
    errors,
    errorRate: attempted > 0 ? errors / attempted : 0,
    rps: elapsedMs > 0 ? ok.length / (elapsedMs / 1000) : 0,
    latency: summarize(ok.map((s) => s.ms)),
  };
}
