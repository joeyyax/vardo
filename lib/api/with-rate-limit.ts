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
  /** Admin settings, user management */
  admin: { limit: 30, windowMs: 60_000 },
  /** Deploy + rollback — extra protection */
  critical: { limit: 10, windowMs: 60_000 },
} as const;

type Tier = keyof typeof TIERS;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (request: NextRequest, context: any) => Promise<Response | NextResponse>;

/** Rate limit identifier from the bearer token or session cookie, else IP. Doesn't validate the session. */
function extractIdentifier(request: NextRequest): string {
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

  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/** Wraps a route handler with Redis-backed rate limiting. */
export function withRateLimit(
  handler: RouteHandler,
  opts: { tier: Tier; key?: string }
): RouteHandler {
  const config = TIERS[opts.tier];

  return async (request, context) => {
    const identifier = extractIdentifier(request);
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
