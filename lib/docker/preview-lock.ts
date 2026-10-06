// ---------------------------------------------------------------------------
// Serializing a PR's preview lifecycle.
//
// GitHub delivers `opened` and `closed` seconds apart while a create takes
// minutes. Create and destroy for one PR run under one lock, and a close
// leaves a tombstone that an in-flight create checks between steps, so the
// last event wins and a fast open/close leaves nothing behind.
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import { redis } from "@/lib/redis";

const LEASE_MS = 60_000;
const RENEW_MS = 20_000;
const POLL_MS = 1_000;
/** A create waits behind another for at most this long. */
export const PREVIEW_LOCK_WAIT_MS = 30 * 60_000;
const TOMBSTONE_TTL_S = 24 * 60 * 60;

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const RENEW = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

function prKey(kind: string, repoFullName: string, prNumber: number): string {
  return `preview:${kind}:${repoFullName.toLowerCase()}:${prNumber}`;
}

export type PreviewLock = { release: () => Promise<void> };

/**
 * Take the PR's lock, waiting up to `waitMs`. Null when the wait ran out.
 * Throws when Redis cannot answer.
 */
export async function acquirePreviewLock(
  repoFullName: string,
  prNumber: number,
  waitMs = PREVIEW_LOCK_WAIT_MS,
): Promise<PreviewLock | null> {
  const key = prKey("lock", repoFullName, prNumber);
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    if ((await redis.set(key, token, "PX", LEASE_MS, "NX")) === "OK") break;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const renew = setInterval(() => {
    redis.eval(RENEW, 1, key, token, String(LEASE_MS)).catch(() => {});
  }, RENEW_MS);
  renew.unref?.();
  return {
    release: async () => {
      clearInterval(renew);
      await redis.eval(RELEASE, 1, key, token).catch(() => {});
    },
  };
}

export async function markPreviewClosed(repoFullName: string, prNumber: number): Promise<void> {
  await redis.set(prKey("closed", repoFullName, prNumber), "1", "EX", TOMBSTONE_TTL_S);
}

export async function clearPreviewClosed(repoFullName: string, prNumber: number): Promise<void> {
  await redis.del(prKey("closed", repoFullName, prNumber));
}

/** Whether the PR was closed after the caller started. Unknown reads as open. */
export async function isPreviewClosed(repoFullName: string, prNumber: number): Promise<boolean> {
  try {
    return (await redis.get(prKey("closed", repoFullName, prNumber))) !== null;
  } catch {
    return false;
  }
}
