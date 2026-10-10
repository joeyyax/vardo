// Bounded retry and backoff for any BackupStorage adapter.

import type { BackupStorage } from "./storage-port";
import { logger } from "@/lib/logger";
import { backoffDelay } from "@/lib/net/backoff";
import { errorStatus, isRetryableError, retry } from "@/lib/net/retry";

const log = logger.child("backup");

/** One initial attempt plus three retries. */
export const MAX_ATTEMPTS = 4;

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;

/** Wall-clock ceiling for a single operation including its retries. */
export const RETRY_BUDGET_MS = 10 * 60 * 1_000;

/** Transient failures only: network and resolver codes, 429 and 5xx. */
export const isRetryableStorageError = (err: unknown): boolean => isRetryableError(err);

/** Equal jitter: half fixed, half random. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  return backoffDelay(attempt, { baseMs: BASE_DELAY_MS, maxMs: MAX_DELAY_MS, jitter: "equal", random });
}

/** Log-safe error tag. Never log the raw error: target configs hold keys. */
function describe(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown error";
  const e = err as { code?: unknown; name?: unknown };
  const parts: string[] = [];
  if (typeof e.code === "string") parts.push(e.code);
  else if (typeof e.name === "string" && e.name !== "Error") parts.push(e.name);
  const status = errorStatus(err);
  if (status !== undefined) parts.push(`HTTP ${status}`);
  return parts.length > 0 ? parts.join(" ") : "unknown error";
}

/** Wraps the last failure with the retry count. */
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

/** Retry one operation on transient failures. */
export async function withRetry<T>(
  operation: string,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  return retry(() => run(), {
    maxAttempts: MAX_ATTEMPTS,
    budgetMs: RETRY_BUDGET_MS,
    baseMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    jitter: "equal",
    retryable: isRetryableStorageError,
    onRetry: ({ attempt, delayMs, error }) =>
      log.warn(
        `${operation} ${key} failed (${describe(error)}) — attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${delayMs}ms`,
      ),
    onGiveUp: (err, { attempts, elapsedMs, retried }) =>
      retried ? new StorageRetryError(err, operation, attempts, elapsedMs) : err,
  });
}

/** Wrap an adapter so its network operations retry on transient failures. */
export function withStorageRetry(storage: BackupStorage): BackupStorage {
  const wrapped: BackupStorage = {
    // Adapters retry the parts they buffer; the stream itself can't be replayed.
    uploadStream: (key, body, opts) => storage.uploadStream(key, body, opts),
    download: (key, destPath) => withRetry("download", key, () => storage.download(key, destPath)),
    delete: (key) => withRetry("delete", key, () => storage.delete(key)),
    list: (prefix) => withRetry("list", prefix, () => storage.list(prefix)),
  };

  // Presigning checks the object exists first.
  if (storage.getDownloadUrl) {
    const getDownloadUrl = storage.getDownloadUrl.bind(storage);
    wrapped.getDownloadUrl = (key, expiresIn) =>
      withRetry("presign", key, () => getDownloadUrl(key, expiresIn));
  }

  return wrapped;
}
