import { NextRequest, NextResponse } from "next/server";
import { auth, ensureGitHubCredentials } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { isPasswordAuthAllowed } from "@/lib/config/provider-restrictions";
import { isFeatureEnabled } from "@/lib/config/features";

const handler = toNextJsHandler(auth);

// Wrap GET to ensure DB-stored GitHub credentials are loaded before first use
export async function GET(request: NextRequest) {
  await ensureGitHubCredentials();
  return handler.GET(request);
}

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

  return handler.POST(request);
}

// POST (login, signup, passkey) gets strict auth-tier rate limiting
async function guardPasswordAuthWithCredentials(request: NextRequest) {
  await ensureGitHubCredentials();
  return guardPasswordAuth(request);
}
export const POST = withRateLimit(guardPasswordAuthWithCredentials, { tier: "auth" });
