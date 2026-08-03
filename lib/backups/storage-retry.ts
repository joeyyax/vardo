// ---------------------------------------------------------------------------
// Backup Storage Retry
//
// Decorates any BackupStorage adapter with bounded retry and backoff, so one
// transient network or DNS failure does not lose a whole nightly run.
// ---------------------------------------------------------------------------

import type { BackupStorage } from "./storage-port";
import { logger } from "@/lib/logger";

const log = logger.child("backup");

/** One initial attempt plus three retries. */
export const MAX_ATTEMPTS = 4;

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;

/** Wall-clock ceiling for a single operation including its retries. */
export const RETRY_BUDGET_MS = 10 * 60 * 1_000;

// Transient socket and resolver failures. EAI_AGAIN is the one killing nightly
// runs; the AWS SDK's own transient list omits it.
const RETRYABLE_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
]);

// scp and ssh exit 255 for every failure, so the reason only exists as text.
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
  statusCode?: unknown;
  stderr?: unknown;
  message?: unknown;
  cause?: unknown;
  $metadata?: { httpStatusCode?: number };
};

function httpStatus(err: ErrorLike): number | undefined {
  const status = err.$metadata?.httpStatusCode ?? err.statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * Transient failures only: network and resolver codes, 429, and 5xx.
 * Everything else — auth, 403, malformed requests — fails on the first attempt
 * rather than being buried under a longer timeout.
 */
export function isRetryableStorageError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > MAX_CAUSE_DEPTH) return false;
  const e = err as ErrorLike;

  if (typeof e.code === "string" && RETRYABLE_CODES.has(e.code)) return true;

  // An explicit status is authoritative — don't fall through to text matching.
  const status = httpStatus(e);
  if (status !== undefined) return status === 429 || (status >= 500 && status <= 599);

  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (RETRYABLE_TEXT.some((pattern) => pattern.test(`${stderr}\n${message}`))) return true;

  return isRetryableStorageError(e.cause, depth + 1);
}

/** Equal jitter — half fixed, half random, so parallel volumes don't retry in lockstep. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** Log-safe error tag. Target configs hold access keys and SSH private keys, so never log the raw error. */
function describe(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown error";
  const e = err as ErrorLike;
  const parts: string[] = [];
  if (typeof e.code === "string") parts.push(e.code);
  else if (typeof e.name === "string" && e.name !== "Error") parts.push(e.name);
  const status = httpStatus(e);
  if (status !== undefined) parts.push(`HTTP ${status}`);
  return parts.length > 0 ? parts.join(" ") : "unknown error";
}

/** Wraps the last failure so the operator sees that it retried, and how often. */
export class StorageRetryError extends Error {
  readonly attempts: number;

  constructor(cause: unknown, operation: string, attempts: number, elapsedMs: number) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const seconds = Math.max(1, Math.round(elapsedMs / 1_000));
    super(`${reason} (${operation} failed after ${attempts} attempts over ${seconds}s)`);
    this.name = "StorageRetryError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  operation: string,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const spent = attempt >= MAX_ATTEMPTS || elapsed >= RETRY_BUDGET_MS;

      if (spent || !isRetryableStorageError(err)) {
        if (attempt > 1) throw new StorageRetryError(err, operation, attempt, elapsed);
        throw err;
      }

      const delay = backoffDelayMs(attempt);
      log.warn(
        `${operation} ${key} failed (${describe(err)}) — attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
}

/**
 * Wrap an adapter so its network operations retry on transient failures.
 * Each attempt re-enters the adapter, so file handles and streams are rebuilt
 * rather than replayed.
 */
export function withStorageRetry(storage: BackupStorage): BackupStorage {
  const wrapped: BackupStorage = {
    upload: (key, filePath) => withRetry("upload", key, () => storage.upload(key, filePath)),
    download: (key, destPath) => withRetry("download", key, () => storage.download(key, destPath)),
    delete: (key) => withRetry("delete", key, () => storage.delete(key)),
  };

  // Presigning signs locally and makes no network call, so there is nothing to retry.
  if (storage.getDownloadUrl) {
    const getDownloadUrl = storage.getDownloadUrl.bind(storage);
    wrapped.getDownloadUrl = (key, expiresIn) => getDownloadUrl(key, expiresIn);
  }

  return wrapped;
}
