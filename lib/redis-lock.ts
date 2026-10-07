import { redis } from "@/lib/redis";

/** Acquire a Redis lock (SET NX PX) that expires after `ttlMs`. False if already held. */
export async function acquireLock(
  key: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await redis.set(key, "1", "PX", ttlMs, "NX");
  return result === "OK";
}

/** Release a lock before its TTL expires. */
export async function releaseLock(key: string): Promise<void> {
  await redis.del(key);
}
