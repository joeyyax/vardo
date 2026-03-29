import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";

const log = logger.child("rate-limit");

// Lua script: sliding window using a sorted set of request timestamps.
// Arguments: key, now (ms), windowMs, limit, ttlSeconds
// Returns: current request count after incrementing (integer)
//
// Member uniqueness: redis.call("TIME") returns {seconds, microseconds},
// giving microsecond resolution — no collision risk under burst traffic.
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
 * Low-level sliding window rate limit check.
 *
 * Returns `{ limited: false }` when the request is allowed, or
 * `{ limited: true, retryAfterSeconds }` when the limit is exceeded.
 *
 * Falls back to allowing the request if Redis is unavailable, so a Redis
 * outage does not block callers.
 *
 * @param identifier - Forgery-resistant string identifying the actor
 *   (e.g. `${userId}:${orgId}`). For unauthenticated contexts the caller
 *   must supply an IP — note x-forwarded-for can be spoofed if not behind a
 *   trusted proxy.
 * @param key - Logical bucket name prefixed onto the Redis key (e.g. "mcp:create-preview").
 */
export async function slidingWindowRateLimit(
  identifier: string,
  key: string,
  limit: number,
  windowMs: number
): Promise<{ limited: false } | { limited: true; retryAfterSeconds: number }> {
  const redisKey = `rl:${key}:${identifier}`;
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
    // Redis unavailable — fail open so a Redis outage doesn't block callers
    log.error("Redis error, failing open:", err);
    return { limited: false };
  }

  if (count > limit) {
    // Accurate retry-after: time until the oldest request drops out of the window.
    let retryAfterSeconds = ttlSeconds;
    try {
      const oldest = await redis.zrange(redisKey, 0, 0, "WITHSCORES");
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
 * Redis-backed sliding window rate limiter for Next.js route handlers.
 * Returns null if the request is allowed, or a 429 NextResponse if rate-limited.
 *
 * Falls back to allowing the request if Redis is unavailable, so a Redis outage
 * does not take down the API.
 *
 * @param identifier - For authenticated routes, pass a forgery-resistant identifier
 *   (e.g. `${userId}:${orgId}`) to prevent IP spoofing bypasses. For unauthenticated
 *   routes the IP is the only available signal — note that x-forwarded-for can be
 *   spoofed if the app is not running behind a trusted proxy that overwrites the header.
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
    opts.key ?? "default",
    opts.limit,
    opts.windowMs
  );

  if (result.limited) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(result.retryAfterSeconds) },
      }
    );
  }

  return null;
}
