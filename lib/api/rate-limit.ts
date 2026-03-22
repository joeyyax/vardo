import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";

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
 * Redis-backed sliding window rate limiter.
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

  const key = `rl:${opts.key ? `${opts.key}:` : ""}${rateLimitId}`;
  const now = Date.now();
  const ttlSeconds = Math.ceil(opts.windowMs / 1000);

  let count: number;
  try {
    const result = await redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      key,
      String(now),
      String(opts.windowMs),
      String(opts.limit),
      String(ttlSeconds)
    );
    count = Number(result);
  } catch (err) {
    // Redis unavailable — fail open so a Redis outage doesn't block the API
    console.error("[rate-limit] Redis error, failing open:", err);
    return null;
  }

  if (count > opts.limit) {
    // Accurate retry-after: time until the oldest request drops out of the window.
    // pttl reflects key-expiry (which resets on every allowed write) and is always
    // the full window size, not the actual wait. Instead, fetch the oldest entry's
    // score (its insertion timestamp in ms) and compute when it will age out.
    let retryAfter = Math.ceil(opts.windowMs / 1000);
    try {
      const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
      // oldest = [member, score] when entries exist
      if (oldest.length >= 2) {
        const oldestMs = Number(oldest[1]);
        const msUntilClear = oldestMs + opts.windowMs - now;
        if (msUntilClear > 0) retryAfter = Math.ceil(msUntilClear / 1000);
      }
    } catch {
      // Best-effort
    }

    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
      }
    );
  }

  return null;
}
