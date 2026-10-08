import { NextRequest, NextResponse } from "next/server";
import { auth, ensureGitHubCredentials } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { isPasswordAuthAllowed } from "@/lib/config/provider-restrictions";
import { isAuthMethodEnabledAsync, getAuthMethodConfig, type AuthMethod } from "@/lib/config/auth-methods";

const handler = toNextJsHandler(auth);

// Endpoint prefixes owned by each sign-in method.
// Refuses a disabled method even if a stale auth instance still mounts its routes.
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

/** Refuses requests to a disabled sign-in method. First-user setup skips the password check. */
async function guardAuthMethods(request: NextRequest): Promise<NextResponse | null> {
  const url = new URL(request.url);
  const authPath = url.pathname.replace(/^\/api\/auth/, "");

  const method = methodForPath(authPath) ?? (await socialProviderMethod(request, authPath));
  if (!method) return null;

  if (method === "password" && !isPasswordAuthAllowed()) {
    return NextResponse.json(
      { error: "Password authentication isn't available on this instance" },
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

async function handleGet(request: NextRequest) {
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

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:auth/*" });
