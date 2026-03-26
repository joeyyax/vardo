import { redis } from "@/lib/redis";

/**
 * Attempt to acquire a distributed lock using Redis SET NX PX.
 * Returns true if the lock was acquired, false if it already exists.
 *
 * The lock expires automatically after `ttlMs` — no explicit release needed.
 */
export async function acquireLock(
  key: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await redis.set(key, "1", "PX", ttlMs, "NX");
  return result === "OK";
}

/**
 * Explicitly release a lock before its TTL expires.
 * Safe to call even if the lock no longer exists.
 */
export async function releaseLock(key: string): Promise<void> {
  await redis.del(key);
}
