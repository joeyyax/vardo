import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { needsSetup } from "@/lib/setup";
import {
  SETUP_TOKEN_COOKIE,
  setupTokenRefusalResponse,
  setupTokenState,
  tokensMatch,
} from "@/lib/setup-token";
import { apiError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";

const bodySchema = z.object({ token: z.string().min(1).max(256) }).strict();

// POST /api/setup/token — trade the setup token for a cookie the rest of setup reads.
async function handler(request: NextRequest) {
  if (!(await needsSetup())) return apiError.forbidden();

  const state = setupTokenState();
  if (state.mode === "open") return NextResponse.json({ ok: true });
  if (state.mode === "unset") return setupTokenRefusalResponse();

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError.validation(parsed.error);
  if (!tokensMatch(parsed.data.token.trim(), state.token)) {
    return NextResponse.json({ error: "That token isn't right.", code: "setup_token_invalid" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SETUP_TOKEN_COOKIE, state.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  return response;
}

export const POST = withRateLimit(handler, { tier: "auth", key: "setup-token" });
