import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";

// Lua script: sliding window using a sorted set of request timestamps.
// Arguments: key, now (ms), windowMs, limit, ttlSeconds
// Returns: current request count after incrementing (integer)
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
  -- Add the current request with score = timestamp (unique member = timestamp + random suffix)
  redis.call("ZADD", key, now, now .. "-" .. math.random(1, 1000000))
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
 */
export async function rateLimit(
  request: NextRequest,
  opts: { key?: string; limit: number; windowMs: number }
): Promise<NextResponse | null> {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  const key = `rl:${opts.key ? `${opts.key}:` : ""}${ip}`;
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
    // Estimate retry-after: fetch TTL of the sorted set
    let retryAfter = Math.ceil(opts.windowMs / 1000);
    try {
      const pttl = await redis.pttl(key);
      if (pttl > 0) retryAfter = Math.ceil(pttl / 1000);
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
