import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { isPasswordAuthAllowed } from "@/lib/config/provider-restrictions";
import { isFeatureEnabled } from "@/lib/config/features";

const { GET: _GET, POST: _POST } = toNextJsHandler(auth);

// GET (session checks) passes through unrated — low abuse risk
export const GET = _GET;

// Paths that require password auth to be allowed
const PASSWORD_AUTH_PATHS = ["/sign-in/email", "/sign-up/email"];

/**
 * Guard password-based auth endpoints when restricted.
 * Setup (first user creation) bypasses this check since there
 * are no other auth methods available yet.
 */
async function guardPasswordAuth(request: NextRequest) {
  const url = new URL(request.url);
  const authPath = url.pathname.replace(/^\/api\/auth/, "");

  if (PASSWORD_AUTH_PATHS.some((p) => authPath.startsWith(p))) {
    const passwordAllowed = isPasswordAuthAllowed() && isFeatureEnabled("passwordAuth");
    if (!passwordAllowed) {
      // Allow setup (first user) — the setup wizard always uses password signup
      const { needsSetup } = await import("@/lib/setup");
      if (!(await needsSetup())) {
        return NextResponse.json(
          { error: "Password authentication is not available on this instance" },
          { status: 403 },
        );
      }
    }
  }

  return _POST(request);
}

// POST (login, signup, passkey) gets strict auth-tier rate limiting
export const POST = withRateLimit(guardPasswordAuth, { tier: "auth" });
