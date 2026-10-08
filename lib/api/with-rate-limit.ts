import { NextRequest, NextResponse } from "next/server";
import { extractIdentifier } from "./request-identity";
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

export { extractIdentifier };
export type Tier = keyof typeof TIERS;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (request: NextRequest, context?: any) => Promise<Response | NextResponse>;

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
