import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "./rate-limit";

/**
 * Rate limit tiers for different endpoint types.
 *
 * Tuned for self-hosted operator usage, not public API scale.
 */
const TIERS = {
  /** Login, signup, passkey — brute-force protection */
  auth: { limit: 10, windowMs: 60_000 },
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
type RouteHandler = (
  request: NextRequest,
  context: any
) => Promise<Response | NextResponse>;

/**
 * Extract a rate limit identifier from the request.
 *
 * For authenticated requests: uses the session user ID (from cookie/header).
 * For unauthenticated: falls back to IP address.
 *
 * This is a lightweight check — it reads the session cookie but doesn't
 * validate it. The route handler does full auth validation.
 */
function extractIdentifier(request: NextRequest): string {
  // Check for Bearer token — hash it for the rate limit key
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    // Use first 16 chars of token as identifier (not full token for privacy)
    return `token:${token.slice(0, 16)}`;
  }

  // Check for session cookie — extract user ID if present
  const sessionToken =
    request.cookies.get("better-auth.session_token")?.value ||
    request.cookies.get("__Secure-better-auth.session_token")?.value;
  if (sessionToken) {
    // Use first 16 chars of session token as identifier
    return `session:${sessionToken.slice(0, 16)}`;
  }

  // Fallback to IP
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Wrap a route handler with Redis-backed rate limiting.
 *
 * Usage:
 * ```ts
 * export const POST = withRateLimit(async (request, context) => {
 *   // ... handler code
 * }, { tier: "mutation" });
 * ```
 */
export function withRateLimit(
  handler: RouteHandler,
  opts: { tier: Tier; key?: string; identifier?: string }
): RouteHandler {
  const config = TIERS[opts.tier];

  return async (request, context) => {
    const identifier = opts.identifier || extractIdentifier(request);
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
