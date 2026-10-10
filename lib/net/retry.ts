// Bounded retry with jittered backoff, transient-error classification and server-requested waits.

import { abortReason, backoffDelay, capDelay, retryAfterMs, sleep as abortableSleep, type Jitter } from "./backoff";

/** Transient socket, resolver and undici failures. ENOTFOUND is left out: NXDOMAIN rarely clears. */
const RETRYABLE_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// Tools like scp exit 255 for every failure, so the reason only exists as text.
const RETRYABLE_TEXT = [
  /temporary failure in name resolution/i,
  /connection timed out/i,
  /connection reset by peer/i,
  /connection refused/i,
  /no route to host/i,
  /broken pipe/i,
];

const MAX_CAUSE_DEPTH = 5;

type ErrorLike = {
  code?: unknown;
  name?: unknown;
  status?: unknown;
  statusCode?: unknown;
  stderr?: unknown;
  message?: unknown;
  cause?: unknown;
  retryAfterMs?: unknown;
  $metadata?: { httpStatusCode?: number };
  response?: { status?: unknown };
};

/** 408, 425, 429 and 5xx other than 501. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599 && status !== 501);
}

/** An HTTP status carried by an error: `status`, `statusCode`, AWS `$metadata` or `response.status`. */
export function errorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as ErrorLike;
  const status = e.$metadata?.httpStatusCode ?? e.status ?? e.statusCode ?? e.response?.status;
  return typeof status === "number" ? status : undefined;
}

/** Transient failures only. An explicit HTTP status is authoritative over codes and causes beneath it. */
export function isRetryableError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > MAX_CAUSE_DEPTH) return false;
  const e = err as ErrorLike;

  if (typeof e.code === "string" && RETRYABLE_CODES.has(e.code)) return true;

  const status = errorStatus(e);
  if (status !== undefined) return isRetryableStatus(status);

  if (e.name === "TimeoutError") return true;

  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (RETRYABLE_TEXT.some((pattern) => pattern.test(`${stderr}\n${message}`))) return true;

  return isRetryableError(e.cause, depth + 1);
}

/** A non-2xx response as an error, carrying its status and requested wait. */
export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, message = `HTTP ${status}`, retryAfter: number | null = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfter;
  }

  static fromResponse(response: Response, message?: string): HttpError {
    return new HttpError(response.status, message ?? `HTTP ${response.status}`, retryAfterMs(response.headers));
  }
}

/** The wait an error asks for, from `retryAfterMs` or a carried response's headers. */
export function errorRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as ErrorLike & { response?: { headers?: Headers } };
  if (typeof e.retryAfterMs === "number") return e.retryAfterMs;
  return e.response?.headers ? retryAfterMs(e.response.headers) : null;
}

export type RetryAttempt = { attempt: number; signal?: AbortSignal };

export type RetryEvent = { attempt: number; maxAttempts: number; delayMs: number; error: unknown };

export type GiveUp = { attempts: number; elapsedMs: number; retried: boolean };

export type RetryOptions = {
  /** Total attempts, first included. */
  maxAttempts?: number;
  /** Wall-clock ceiling across attempts and waits. */
  budgetMs?: number;
  baseMs?: number;
  maxDelayMs?: number;
  jitter?: Jitter;
  /** Ceiling on a server-requested wait. */
  maxRetryAfterMs?: number;
  signal?: AbortSignal;
  retryable?: (err: unknown, attempt: number) => boolean;
  retryAfter?: (err: unknown) => number | null;
  onRetry?: (event: RetryEvent) => void;
  /** Maps the final error before it's thrown. */
  onGiveUp?: (err: unknown, info: GiveUp) => unknown;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

export const RETRY_DEFAULTS = {
  maxAttempts: 3,
  baseMs: 500,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 60_000,
} as const;

/** Runs `fn` until it succeeds, fails non-transiently, or spends its attempts, budget or signal. */
export async function retry<T>(fn: (ctx: RetryAttempt) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = RETRY_DEFAULTS.maxAttempts,
    budgetMs = Infinity,
    baseMs = RETRY_DEFAULTS.baseMs,
    maxDelayMs = RETRY_DEFAULTS.maxDelayMs,
    jitter = "full",
    maxRetryAfterMs = RETRY_DEFAULTS.maxRetryAfterMs,
    signal,
    retryable = isRetryableError,
    retryAfter = errorRetryAfterMs,
    onRetry,
    onGiveUp,
    sleep = abortableSleep,
    random,
    now = Date.now,
  } = opts;

  const startedAt = now();
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await fn({ attempt, signal });
    } catch (err) {
      if (signal?.aborted) throw abortReason(signal);

      const elapsedMs = now() - startedAt;
      const backoff = backoffDelay(attempt, { baseMs, maxMs: maxDelayMs, jitter, random });
      const requested = retryAfter(err);
      const delayMs = requested === null ? backoff : Math.max(backoff, capDelay(requested, maxRetryAfterMs));
      const spent = attempt >= maxAttempts || elapsedMs + delayMs > budgetMs;

      if (spent || !retryable(err, attempt)) {
        throw onGiveUp ? onGiveUp(err, { attempts: attempt, elapsedMs, retried: attempt > 1 }) : err;
      }

      onRetry?.({ attempt, maxAttempts, delayMs, error: err });
      await sleep(delayMs, signal);
    }
  }
}
