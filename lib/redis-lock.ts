import { randomUUID } from "crypto";
import { redis } from "@/lib/redis";

// Deletes the key only while it still holds this owner's token.
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Acquire a Redis lock (SET NX PX) that expires after `ttlMs`. Returns the owner token, or null if already held. */
export async function acquireLock(
  key: string,
  ttlMs: number,
): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(key, token, "PX", ttlMs, "NX");
  return result === "OK" ? token : null;
}

/** Release a lock before its TTL expires. A no-op once another owner holds it. */
export async function releaseLock(key: string, token: string): Promise<boolean> {
  const deleted = await redis.eval(RELEASE_SCRIPT, 1, key, token);
  return deleted === 1;
}
