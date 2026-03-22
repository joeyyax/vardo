import { NextRequest, NextResponse } from "next/server";

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}, 60000);

/**
 * Simple in-memory rate limiter.
 * Returns null if allowed, or a 429 NextResponse if rate-limited.
 */
export function rateLimit(
  request: NextRequest,
  opts: { key?: string; limit: number; windowMs: number }
): NextResponse | null {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
  const key = opts.key ? `${opts.key}:${ip}` : ip;
  const now = Date.now();

  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + opts.windowMs });
    return null;
  }

  entry.count++;
  if (entry.count > opts.limit) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
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
