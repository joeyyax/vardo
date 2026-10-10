// Backoff delays and server-requested waits (Retry-After, rate-limit headers). Isomorphic: no server imports.

export type Jitter = "full" | "equal" | "none";

export type BackoffOptions = {
  /** Delay ceiling for the first retry. */
  baseMs: number;
  maxMs: number;
  /** `full` picks 0..ceiling, `equal` ceiling/2..ceiling, `none` the ceiling. */
  jitter?: Jitter;
  /** Floor under any jittered delay. */
  minMs?: number;
  random?: () => number;
};

/** Delay before retry `attempt` (1-indexed): exponential from `baseMs`, capped at `maxMs`, then jittered. */
export function backoffDelay(attempt: number, opts: BackoffOptions): number {
  const { baseMs, maxMs, jitter = "full", minMs = 0, random = Math.random } = opts;
  const exponent = Math.max(0, Math.min(attempt - 1, 52));
  const ceiling = Math.max(minMs, Math.min(baseMs * 2 ** exponent, maxMs));
  const r = Math.min(1, Math.max(0, random()));
  let delay: number;
  if (jitter === "none") delay = ceiling;
  else if (jitter === "equal") delay = ceiling / 2 + r * (ceiling / 2);
  else delay = minMs + r * (ceiling - minMs);
  return Math.round(Math.max(minMs, delay));
}

/** Retry-After as milliseconds: delta-seconds or an HTTP-date. Null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  // An HTTP-date always names its day and month; Date.parse reads "-5" as a year.
  if (!/[a-z]/i.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

type HeaderSource = Headers | Record<string, string | string[] | number | undefined | null> | null | undefined;

function header(headers: HeaderSource, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  if (value == null) return null;
  return Array.isArray(value) ? String(value[0]) : String(value);
}

/** Leading number of a header like `0;w=21600`. */
function leadingNumber(value: string | null): number | null {
  const match = value?.trim().match(/^-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/** Epoch seconds above this are a timestamp; below it, a delta. */
const EPOCH_THRESHOLD_S = 1_000_000_000;

function resetDelay(value: string | null, now: number): number | null {
  const n = leadingNumber(value);
  if (n === null || n < 0) return null;
  return n > EPOCH_THRESHOLD_S ? Math.max(0, n * 1000 - now) : Math.round(n * 1000);
}

/**
 * The wait a response asks for: Retry-After first, then an exhausted rate-limit window
 * (GitHub `x-ratelimit-*`, IETF `ratelimit-*`). Null when it asks for none.
 */
export function retryAfterMs(headers: HeaderSource, now = Date.now()): number | null {
  const retryAfter = parseRetryAfter(header(headers, "retry-after"), now);
  if (retryAfter !== null) return retryAfter;

  for (const prefix of ["x-ratelimit-", "ratelimit-"]) {
    const remaining = leadingNumber(header(headers, `${prefix}remaining`));
    if (remaining !== 0) continue;
    const reset = resetDelay(header(headers, `${prefix}reset`), now);
    if (reset !== null) return reset;
  }
  return null;
}

/** Clamps a requested wait to `[0, maxMs]`. */
export function capDelay(ms: number, maxMs: number): number {
  return Math.min(Math.max(0, ms), maxMs);
}

/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
