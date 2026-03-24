import { NextRequest, NextResponse } from "next/server";

/**
 * Layer 1: In-memory IP-based rate limiting on all API routes.
 *
 * Lightweight safety net that runs before any Redis or DB calls.
 * Catches brute-force and DoS before they hit the application.
 *
 * 200 requests per minute per IP. Bounded Map prevents memory leaks.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 200;
const MAX_TRACKED_IPS = 10_000;

type Entry = { count: number; resetAt: number };
const ipMap = new Map<string, Entry>();

// Periodic cleanup — remove expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipMap) {
    if (now > entry.resetAt) ipMap.delete(ip);
  }
}, 5 * 60_000);

function getIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function proxy(request: NextRequest) {
  // Only rate limit API routes
  if (!request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Skip health check and monitoring endpoints
  if (request.nextUrl.pathname === "/api/health") {
    return NextResponse.next();
  }

  // Skip OPTIONS/HEAD — only limit actual requests
  const method = request.method.toUpperCase();
  if (method === "OPTIONS" || method === "HEAD") {
    return NextResponse.next();
  }

  const ip = getIp(request);
  const now = Date.now();

  let entry = ipMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };

    // Evict oldest if map is full (prevent memory leak)
    if (ipMap.size >= MAX_TRACKED_IPS) {
      const oldest = ipMap.keys().next().value;
      if (oldest) ipMap.delete(oldest);
    }

    ipMap.set(ip, entry);
  }

  entry.count++;

  if (entry.count > MAX_REQUESTS) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.max(retryAfter, 1)) },
      }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
