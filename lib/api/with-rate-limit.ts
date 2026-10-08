import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { rateLimit } from "./rate-limit";

/** Rate limit tiers by endpoint type, tuned for self-hosted use. */
const TIERS = {
  /** Login, signup, passkey, invite codes — brute-force protection */
  auth: { limit: 5, windowMs: 60_000 },
  /** Webhook, mesh join — public but untrusted */
  public: { limit: 30, windowMs: 60_000 },
  /** Deploy, rollback, create/update/delete resources */
  mutation: { limit: 60, windowMs: 60_000 },
  /** List, get, search — high limit, low abuse risk */
  read: { limit: 120, windowMs: 60_000 },
  /** Endpoints the UI polls every few seconds; sized for ~10 open tabs */
  poll: { limit: 300, windowMs: 60_000 },
  /** Downloads, exports and lookups that fan out to disk or third parties */
  heavy: { limit: 30, windowMs: 60_000 },
  /** Admin settings, user management */
  admin: { limit: 30, windowMs: 60_000 },
  /** Deploy + rollback — extra protection */
  critical: { limit: 10, windowMs: 60_000 },
} as const;

export type Tier = keyof typeof TIERS;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (request: NextRequest, context?: any) => Promise<Response | NextResponse>;

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/** Rate limit identifier from the bearer token or session cookie, else IP. Doesn't validate the session. */
export function extractIdentifier(request: NextRequest, tier?: Tier): string {
  // Credentials are unverified here, so a fresh cookie per request would mean a fresh bucket.
  if (tier === "auth") return clientIp(request);

  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const hash = createHash("sha256").update(token).digest("hex").slice(0, 16);
    return `token:${hash}`;
  }

  const sessionToken =
    request.cookies.get("better-auth.session_token")?.value ||
    request.cookies.get("__Secure-better-auth.session_token")?.value;
  if (sessionToken) {
    const hash = createHash("sha256").update(sessionToken).digest("hex").slice(0, 16);
    return `session:${hash}`;
  }

  return clientIp(request);
}

/** Wraps a route handler with Redis-backed rate limiting. */
export function withRateLimit(
  handler: RouteHandler,
  opts: { tier: Tier; key?: string }
): RouteHandler {
  const config = TIERS[opts.tier];

  return async (request, context) => {
    const identifier = extractIdentifier(request, opts.tier);
    const tierKey = opts.key || opts.tier;

    const limited = await rateLimit(request, {
      key: tierKey,
      limit: config.limit,
      windowMs: config.windowMs,
      identifier,
    });

    if (limited) return limited;

    return handler(request, context);
  };
}
