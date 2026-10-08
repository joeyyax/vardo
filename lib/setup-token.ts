import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { needsSetup } from "@/lib/setup";

export const SETUP_TOKEN_COOKIE = "vardo_setup_token";
export const SETUP_TOKEN_HEADER = "x-setup-token";
export const SETUP_TOKEN_MIN_LENGTH = 16;

export type SetupTokenState =
  /** No token configured outside production: dev instances skip the check. */
  | { mode: "open" }
  /** Production without a usable SETUP_TOKEN: setup refuses everything. */
  | { mode: "unset" }
  | { mode: "required"; token: string };

export function setupTokenState(): SetupTokenState {
  const token = process.env.SETUP_TOKEN?.trim() ?? "";
  if (token.length >= SETUP_TOKEN_MIN_LENGTH) return { mode: "required", token };
  return process.env.NODE_ENV === "production" ? { mode: "unset" } : { mode: "open" };
}

/** Constant-time compare. Hashing first equalizes lengths. */
export function tokensMatch(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Whether the request carries the setup token, by header or cookie. Always true when none is required. */
export function hasSetupToken(headers: Headers): boolean {
  const state = setupTokenState();
  if (state.mode === "open") return true;
  if (state.mode === "unset") return false;
  return (
    tokensMatch(headers.get(SETUP_TOKEN_HEADER), state.token) ||
    tokensMatch(cookieValue(headers.get("cookie"), SETUP_TOKEN_COOKIE), state.token)
  );
}

export function setupTokenRefusalResponse(): NextResponse {
  if (setupTokenState().mode === "unset") {
    return NextResponse.json(
      { error: "This instance has no setup token. Run `vardo setup-token` on the host.", code: "setup_token_unset" },
      { status: 503 },
    );
  }
  return NextResponse.json(
    { error: "Enter the setup token to continue.", code: "setup_token_required" },
    { status: 401 },
  );
}

/**
 * Refuses while no user exists and the request lacks the setup token. Returns null to continue,
 * so routes keep their own auth once setup has latched.
 */
export async function setupTokenRefusal(request: Request): Promise<NextResponse | null> {
  if (!(await needsSetup())) return null;
  return hasSetupToken(request.headers) ? null : setupTokenRefusalResponse();
}
