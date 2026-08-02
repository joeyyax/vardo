import { NextRequest, NextResponse } from "next/server";
import { auth, ensureGitHubCredentials } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { isPasswordAuthAllowed } from "@/lib/config/provider-restrictions";
import { isAuthMethodEnabledAsync, getAuthMethodConfig, type AuthMethod } from "@/lib/config/auth-methods";

const handler = toNextJsHandler(auth);

// Endpoint prefixes owned by each sign-in method. Checked against the path
// under /api/auth, so a disabled method is refused even if a stale auth
// instance still has its routes mounted.
const METHOD_PATHS: [AuthMethod, string[]][] = [
  ["password", ["/sign-in/email", "/sign-up/email", "/forget-password", "/reset-password", "/change-password"]],
  ["passkey", ["/passkey", "/sign-in/passkey"]],
  ["magic-link", ["/sign-in/magic-link", "/magic-link"]],
  ["totp", ["/two-factor"]],
  ["github", ["/callback/github", "/oauth2/callback/github"]],
];

function methodForPath(authPath: string): AuthMethod | null {
  for (const [method, prefixes] of METHOD_PATHS) {
    if (prefixes.some((p) => authPath.startsWith(p))) return method;
  }
  return null;
}

/** Social sign-in names its provider in the body rather than the path. */
async function socialProviderMethod(request: NextRequest, authPath: string): Promise<AuthMethod | null> {
  if (!authPath.startsWith("/sign-in/social") && !authPath.startsWith("/link-social")) return null;
  try {
    const body = await request.clone().json();
    return body?.provider === "github" ? "github" : null;
  } catch {
    return null;
  }
}

/**
 * Refuse requests to a sign-in method that is switched off. Creating the first
 * user bypasses the password check, since setup has no other way in.
 */
async function guardAuthMethods(request: NextRequest): Promise<NextResponse | null> {
  const url = new URL(request.url);
  const authPath = url.pathname.replace(/^\/api\/auth/, "");

  const method = methodForPath(authPath) ?? (await socialProviderMethod(request, authPath));
  if (!method) return null;

  if (method === "password" && !isPasswordAuthAllowed()) {
    return NextResponse.json(
      { error: "Password authentication is not available on this instance" },
      { status: 403 },
    );
  }

  if (await isAuthMethodEnabledAsync(method)) return null;

  if (method === "password") {
    const { needsSetup } = await import("@/lib/setup");
    if (await needsSetup()) return null;
  }

  return NextResponse.json(
    { error: `${getAuthMethodConfig(method).label} sign-in is turned off on this instance` },
    { status: 403 },
  );
}

export async function GET(request: NextRequest) {
  await ensureGitHubCredentials();
  const blocked = await guardAuthMethods(request);
  if (blocked) return blocked;
  return handler.GET(request);
}

// POST (login, signup, passkey) gets strict auth-tier rate limiting
async function handlePost(request: NextRequest) {
  await ensureGitHubCredentials();
  const blocked = await guardAuthMethods(request);
  if (blocked) return blocked;
  return handler.POST(request);
}

export const POST = withRateLimit(handlePost, { tier: "auth" });
