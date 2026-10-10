// Puts the two-factor challenge in front of magic-link and OAuth sign-ins, as the twoFactor plugin does for passwords.

import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";

/** No provider is trusted: OAuth links to an existing user only with an email the provider verified. */
export const ACCOUNT_LINKING = { enabled: true, trustedProviders: [] as string[] };

/** The twoFactor plugin's cookie, which /two-factor/verify-* reads. */
const TWO_FACTOR_COOKIE_NAME = "two_factor";
const CHALLENGE_MAX_AGE = 600;

/** Sign-in endpoints that end in a session without passing the twoFactor plugin's hook. */
export function needsSecondFactorHook(path: string | undefined): boolean {
  return path === "/magic-link/verify" || path === "/callback/:id" || path === "/oauth2/callback/:providerId";
}

/** A same-origin path to return to after the challenge, from the endpoint's redirect. */
export function returnPath(location: string | null | undefined, baseURL: string): string {
  if (!location) return "/";
  try {
    const base = new URL(baseURL);
    const url = new URL(location, base);
    if (url.origin !== base.origin) return "/";
    return `${url.pathname}${url.search}` || "/";
  } catch {
    return "/";
  }
}

export function secondFactorEverywhere(): BetterAuthPlugin {
  return {
    id: "vardo-second-factor",
    hooks: {
      after: [
        {
          matcher: (ctx) => needsSecondFactorHook(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const data = ctx.context.newSession;
            if (!data || !(data.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled) return;

            deleteSessionCookie(ctx, true);
            await ctx.context.internalAdapter.deleteSession(data.session.token);
            ctx.context.setNewSession(null);

            const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME, { maxAge: CHALLENGE_MAX_AGE });
            const identifier = `2fa-${generateRandomString(20)}`;
            const expiresAt = new Date(Date.now() + CHALLENGE_MAX_AGE * 1000);
            await ctx.context.internalAdapter.createVerificationValue({ value: data.user.id, identifier, expiresAt });
            await ctx.context.internalAdapter.createVerificationValue({
              value: "0",
              identifier: `2fa-attempts-${identifier}`,
              expiresAt,
            });
            await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes);

            const returned = ctx.context.returned as { headers?: Headers } | undefined;
            const back = returnPath(returned?.headers?.get?.("location"), ctx.context.baseURL);
            const origin = new URL(ctx.context.baseURL).origin;
            throw ctx.redirect(`${origin}/login/2fa?callbackUrl=${encodeURIComponent(back)}`);
          }),
        },
      ],
    },
  };
}
