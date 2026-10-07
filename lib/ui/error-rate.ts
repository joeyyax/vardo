// Error rate against the app's own baseline. Elevated only when ratio, percentile,
// floor and error-share guards all agree.

/** How often the collector writes a sample. */
export const SAMPLE_MS = 5 * 60_000;

/** Samples per 30-minute evaluation window. */
export const WINDOW_SAMPLES = 6;
export const WINDOW_MS = WINDOW_SAMPLES * SAMPLE_MS;

/** How far back the comparison reaches. Matches the metrics store's retention. */
export const BASELINE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum baseline coverage before judging. */
export const MIN_BASELINE_SPAN_MS = 3 * 24 * 60 * 60 * 1000;
export const MIN_BASELINE_WINDOWS = 288;

/** No sample within this means collection stopped, not a zero rate. */
export const STALE_AFTER_MS = 3 * SAMPLE_MS;

/** How long a deploy or restart keeps replaying startup logging. */
export const SETTLE_MS = 15 * 60_000;

/** Cap on an unfinished deploy's quiet window. */
export const DEPLOY_MAX_MS = 30 * 60_000;

const RATIO = 4;
const PERCENTILE = 0.99;
const HEADROOM = 1.5;
const FLOOR = 20;
const SHARE_GUARD = 1.25;

export type RateSample = { at: number; errors: number; lines: number };

/** A span the rate is not judged over. */
export type QuietWindow = { from: number; to: number };

export type DeployWindow = { startedAt: Date | string | number; finishedAt: Date | string | number | null };

function ms(value: Date | string | number): number {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
}

/** Spans after deploys and restarts where the rate isn't judged. */
export function quietWindows(
  deploys: DeployWindow[],
  restarts: (Date | string | number | null)[],
): QuietWindow[] {
  const windows: QuietWindow[] = [];

  for (const d of deploys) {
    const from = ms(d.startedAt);
    if (!Number.isFinite(from)) continue;
    const finished = d.finishedAt === null ? NaN : ms(d.finishedAt);
    const to = Number.isFinite(finished) ? finished : from + DEPLOY_MAX_MS;
    windows.push({ from, to: Math.min(to, from + DEPLOY_MAX_MS) + SETTLE_MS });
  }

  for (const r of restarts) {
    if (r === null) continue;
    const from = ms(r);
    if (!Number.isFinite(from)) continue;
    windows.push({ from, to: from + SETTLE_MS });
  }

  return windows.sort((a, b) => a.from - b.from);
}

export function overlapsQuiet(from: number, to: number, windows: QuietWindow[]): boolean {
  return windows.some((w) => from <= w.to && to >= w.from);
}

export type RateWindow = { at: number; errors: number; lines: number };

/** Rolling sums over `WINDOW_SAMPLES` contiguous samples. Windows spanning a gap are skipped. */
export function windowSums(samples: RateSample[]): RateWindow[] {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const out: RateWindow[] = [];

  for (let i = WINDOW_SAMPLES - 1; i < sorted.length; i++) {
    const first = sorted[i - WINDOW_SAMPLES + 1];
    const last = sorted[i];
    if (last.at - first.at !== (WINDOW_SAMPLES - 1) * SAMPLE_MS) continue;

    let errors = 0;
    let lines = 0;
    for (let j = i - WINDOW_SAMPLES + 1; j <= i; j++) {
      errors += sorted[j].errors;
      lines += sorted[j].lines;
    }
    out.push({ at: last.at, errors, lines });
  }

  return out;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))];
}

export type ErrorRateStatus = "idle" | "learning" | "settling" | "normal" | "elevated";

export type ErrorRateReading = {
  status: ErrorRateStatus;
  /** Matches in the last 30 minutes, or null when no window is covered. */
  recent: number | null;
  /** Usual matches per 30 minutes, or null while there is nothing to compare against. */
  baseline: number | null;
  /** Fraction of the baseline window that is covered, 0 to 1. */
  coverage: number;
  headline: string;
  detail: string;
};

export type ReadingInput = {
  now: number;
  /** Any order. */
  samples: RateSample[];
  quiet: QuietWindow[];
};

export function errorRateReading({ now, samples, quiet }: ReadingInput): ErrorRateReading {
  const windows = windowSums(samples);
  const current = windows[windows.length - 1];

  const newest = samples.reduce((max, s) => Math.max(max, s.at), 0);
  if (newest === 0 || now - newest > STALE_AFTER_MS) {
    return {
      status: "idle",
      recent: null,
      baseline: null,
      coverage: 0,
      headline: "Not collecting",
      detail: "Nothing has been sampled recently. The rate is only measured while the app is running.",
    };
  }

  const baselineWindows = current
    ? windows.filter(
        (w) =>
          w.at <= current.at - WINDOW_MS &&
          w.at > current.at - BASELINE_MS &&
          !overlapsQuiet(w.at - WINDOW_MS, w.at, quiet),
      )
    : [];

  const coverage = Math.min(1, baselineWindows.length / (BASELINE_MS / SAMPLE_MS));
  const span = baselineWindows.length
    ? baselineWindows[baselineWindows.length - 1].at - baselineWindows[0].at
    : 0;

  if (!current || span < MIN_BASELINE_SPAN_MS || baselineWindows.length < MIN_BASELINE_WINDOWS) {
    return {
      status: "learning",
      recent: current?.errors ?? null,
      baseline: null,
      coverage,
      headline: "Learning what normal looks like",
      detail: `Comparison starts after ${days(MIN_BASELINE_SPAN_MS)} of history. ${learned(span)} so far.`,
    };
  }

  const usual = median(baselineWindows.map((w) => w.errors));

  if (overlapsQuiet(current.at - WINDOW_MS, current.at, quiet)) {
    return {
      status: "settling",
      recent: current.errors,
      baseline: usual,
      coverage,
      headline: "Settling after a restart",
      detail: `A deploy or restart replays startup logging, so the rate is not judged for ${minutes(SETTLE_MS)} afterwards.`,
    };
  }

  const against = `${current.errors} in the last ${minutes(WINDOW_MS)}, against a usual ${round(usual)}`;

  if (isStepChange(current, baselineWindows, usual)) {
    return {
      status: "elevated",
      recent: current.errors,
      baseline: usual,
      coverage,
      headline: "Errors up",
      detail: `${against}. Higher than any half hour in the past week.`,
    };
  }

  return {
    status: "normal",
    recent: current.errors,
    baseline: usual,
    coverage,
    headline: "Normal",
    detail: `${against}.`,
  };
}

function isStepChange(current: RateWindow, baseline: RateWindow[], usual: number): boolean {
  if (current.errors < FLOOR) return false;
  if (current.errors < usual * RATIO) return false;

  const worst = percentile(baseline.map((w) => w.errors), PERCENTILE);
  if (current.errors <= Math.max(worst * HEADROOM, worst + 1)) return false;

  const usualShare = median(baseline.filter((w) => w.lines > 0).map((w) => w.errors / w.lines));
  if (usualShare > 0) {
    const share = current.lines > 0 ? current.errors / current.lines : 1;
    // A flat error share means the app is only busier.
    if (share <= usualShare * SHARE_GUARD) return false;
  }

  return true;
}

/** Text tone for an error-rate status. */
export function errorRateTone(status: ErrorRateStatus): string {
  return status === "elevated" ? "text-status-warning" : status === "normal" ? "text-status-success" : "text-muted-foreground";
}

/** Muted band behind the verdict, matched to errorRateTone. */
export function errorRateSurface(status: ErrorRateStatus): string {
  if (status === "elevated") return "border-status-warning-edge bg-status-warning-muted";
  if (status === "normal") return "border-status-success-edge bg-status-success-muted";
  return "border-border bg-muted/40";
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function minutes(value: number): string {
  return `${Math.round(value / 60_000)} minutes`;
}

function days(value: number): string {
  const n = Math.round(value / 86_400_000);
  return `${n} day${n === 1 ? "" : "s"}`;
}

function learned(span: number): string {
  const hours = Math.floor(span / 3_600_000);
  if (hours < 1) return "Under an hour";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}
