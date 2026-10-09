/** Server read tier: requests per minute per token per route. */
export const READ_LIMIT_PER_MIN = 120;
/** Default pacing stays at this share of the limit. */
export const PACE_FRACTION = 0.9;
/** Wait after a 429 that carries no usable header. */
export const DEFAULT_BACKOFF_MS = 5_000;
/** Longest wait honored from a header (the limiter window is 60s). */
export const MAX_BACKOFF_MS = 65_000;

/** Requests per minute for one token on one route. */
export function defaultRate(limit = READ_LIMIT_PER_MIN, fraction = PACE_FRACTION): number {
  return limit * fraction;
}

type HeaderGet = (name: string) => string | null;

/** Milliseconds to wait after a 429: Retry-After (seconds or date), then RateLimit-Reset and X-RateLimit-Reset. Null when absent. */
export function parseBackoffMs(get: HeaderGet, nowMs = Date.now()): number | null {
  const clamp = (ms: number) => Math.min(MAX_BACKOFF_MS, Math.max(0, Math.ceil(ms)));

  const retry = get("retry-after")?.trim();
  if (retry) {
    if (/^\d+(\.\d+)?$/.test(retry)) return clamp(Number(retry) * 1000);
    const date = Date.parse(retry);
    if (!Number.isNaN(date)) return clamp(date - nowMs);
  }

  for (const name of ["ratelimit-reset", "x-ratelimit-reset"]) {
    const raw = get(name)?.trim();
    if (!raw || !/^\d+(\.\d+)?$/.test(raw)) continue;
    const n = Number(raw);
    // Values past ~year 2001 in seconds are epoch timestamps; smaller ones are delta seconds.
    return clamp(n > 1e9 ? n * 1000 - nowMs : n * 1000);
  }
  return null;
}

/** Evenly spaced request slots shared by all workers on one route. */
export class Pacer {
  private readonly intervalMs: number;
  private next: number;

  constructor(ratePerMin: number, startMs = 0) {
    if (!(ratePerMin > 0)) throw new Error("rate must be positive");
    this.intervalMs = 60_000 / ratePerMin;
    this.next = startMs;
  }

  /** Claims the next slot and returns its time. Callers wait until then. */
  reserve(nowMs: number): number {
    const slot = Math.max(this.next, nowMs);
    this.next = slot + this.intervalMs;
    return slot;
  }

  /** Pushes every later slot to at least `untilMs`. */
  penalize(untilMs: number): void {
    this.next = Math.max(this.next, untilMs);
  }
}

/** Share of requests that drew a 429 above which latencies stop meaning anything. */
export const LIMITED_THRESHOLD = 0.05;

export function isRateLimited(requests: number, limited: number): boolean {
  return requests > 0 && limited / requests > LIMITED_THRESHOLD;
}
