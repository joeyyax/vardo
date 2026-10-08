import { NextRequest, NextResponse } from "next/server";
import { csrfRejection } from "@/lib/security/csrf";
import { clientIpFor } from "@/lib/security/client-ip";
import { hasValidCredentials } from "@/lib/security/proxy-credentials";

/**
 * Layer 1: In-memory IP-based rate limiting on all API routes.
 *
 * Lightweight safety net that runs before any Redis or DB calls.
 * Catches brute-force and DoS before they hit the application.
 *
 * 200 requests per minute per IP, counting only requests without a valid session or
 * API token. Signed-in requests are limited per route by withRateLimit. Bounded Map prevents memory leaks.
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

export async function proxy(request: NextRequest) {
  // Only rate limit API routes
  if (!request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Downstream readers (rate limits, Better Auth) see only the vetted address.
  const ip = await clientIpFor(request.headers);
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-for", ip);
  headers.set("x-real-ip", ip);
  const next = () => NextResponse.next({ request: { headers } });

  const csrf = csrfRejection({
    method: request.method,
    pathname: request.nextUrl.pathname,
    headers: request.headers,
  });
  if (csrf) {
    return NextResponse.json({ error: "Cross-site request blocked" }, { status: 403 });
  }

  // Skip health check and monitoring endpoints
  if (request.nextUrl.pathname === "/api/health") {
    return next();
  }

  // Skip OPTIONS/HEAD — only limit actual requests
  const method = request.method.toUpperCase();
  if (method === "OPTIONS" || method === "HEAD") {
    return next();
  }

  const now = Date.now();

  // Past its budget an address gets no further credential lookups beyond what is cached.
  const seen = ipMap.get(ip);
  const spent = !!seen && now <= seen.resetAt && seen.count >= MAX_REQUESTS;
  if (await hasValidCredentials(request.headers, { lookup: !spent, now })) {
    return next();
  }

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

  return next();
}

export const config = {
  matcher: "/api/:path*",
};
