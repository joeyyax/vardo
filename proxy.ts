import { NextRequest, NextResponse } from "next/server";

// Simple in-memory rate limiter for auth endpoints
const authAttempts = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authAttempts) {
    if (entry.resetAt <= now) authAttempts.delete(key);
  }
}, 60000);

export function middleware(request: NextRequest) {
  // Rate limit auth POST requests (login, signup, magic link, etc.)
  if (request.nextUrl.pathname.startsWith("/api/auth/") && request.method === "POST") {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("x-real-ip")
      || "unknown";
    const key = `auth:${ip}`;
    const now = Date.now();

    const entry = authAttempts.get(key);
    if (!entry || entry.resetAt <= now) {
      authAttempts.set(key, { count: 1, resetAt: now + 60000 });
    } else {
      entry.count++;
      if (entry.count > 10) {
        return NextResponse.json(
          { error: "Too many requests" },
          { status: 429, headers: { "Retry-After": String(Math.ceil((entry.resetAt - now) / 1000)) } }
        );
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/auth/:path*"],
};
