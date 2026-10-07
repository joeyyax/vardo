import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";

const log = logger.child("rate-limit");

// Sliding window over a sorted set. Args: key, now (ms), windowMs, limit, ttlSeconds. Returns the count.
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local cutoff = now - window

-- Remove timestamps outside the window
redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)

-- Count requests in current window
local count = redis.call("ZCARD", key)

if count < limit then
  -- Unique member: microsecond-resolution Redis server time eliminates collision risk
  local t = redis.call("TIME")
  local member = t[1] .. "-" .. t[2]
  redis.call("ZADD", key, now, member)
  redis.call("EXPIRE", key, ttl)
  return count + 1
else
  return count + 1
end
`.trim();

/**
 * Sliding window rate limit check. Fails open when Redis is unavailable.
 * @param identifier - Forgery-resistant actor id (e.g. `${userId}:${orgId}`); x-forwarded-for IPs are spoofable.
 * @param key - Bucket name prefixed onto the Redis key; empty gives a bare `rl:${identifier}` key.
 */
export async function slidingWindowRateLimit(
  identifier: string,
  key: string,
  limit: number,
  windowMs: number
): Promise<{ limited: false } | { limited: true; retryAfterSeconds: number }> {
  const redisKey = key ? `rl:${key}:${identifier}` : `rl:${identifier}`;
  const now = Date.now();
  const ttlSeconds = Math.ceil(windowMs / 1000);

  let count: number;
  try {
    const result = await redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      redisKey,
      String(now),
      String(windowMs),
      String(limit),
      String(ttlSeconds)
    );
    count = Number(result);
  } catch (err) {
    // Fail open.
    log.error("Redis error, failing open:", err);
    return { limited: false };
  }

  if (count > limit) {
    // Time until the oldest request leaves the window.
    let retryAfterSeconds = ttlSeconds;
    try {
      const oldest = await redis.zrange(redisKey, 0, "0", "WITHSCORES");
      if (oldest.length >= 2) {
        const oldestMs = Number(oldest[1]);
        const msUntilClear = oldestMs + windowMs - now;
        if (msUntilClear > 0) retryAfterSeconds = Math.ceil(msUntilClear / 1000);
      }
    } catch {
      // Best-effort
    }
    return { limited: true, retryAfterSeconds };
  }

  return { limited: false };
}

/**
 * Rate limiter for route handlers: null when allowed, else a 429. Fails open when Redis is unavailable.
 * @param identifier - Forgery-resistant id for authenticated routes; x-forwarded-for IPs are spoofable.
 */
export async function rateLimit(
  request: NextRequest,
  opts: { key?: string; limit: number; windowMs: number; identifier?: string }
): Promise<NextResponse | null> {
  const rateLimitId =
    opts.identifier ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";

  const result = await slidingWindowRateLimit(
    rateLimitId,
    opts.key ?? "",
    opts.limit,
    opts.windowMs
  );

  if (result.limited) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(result.retryAfterSeconds) },
      }
    );
  }

  return null;
}
