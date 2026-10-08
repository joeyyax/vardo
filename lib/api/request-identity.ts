import { NextRequest } from "next/server";
import { createHash } from "crypto";

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/** Rate limit identifier from the bearer token or session cookie, else IP. Doesn't validate the session. */
export function extractIdentifier(request: NextRequest, tier?: string): string {
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
