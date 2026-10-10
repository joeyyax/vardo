import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import { twoFactor, magicLink } from "better-auth/plugins";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { DEFAULT_APP_NAME } from "@/lib/constants";
import { createDefaultOrgForUser } from "@/lib/organizations/create-default-org";
import { REGISTRATION_CLOSED_MESSAGE, SETUP_TOKEN_MESSAGE, registrationAllowed, setupTokenAllowsSignup, shouldCreateDefaultOrg } from "@/lib/auth/registration";
import { isAuthMethodEnabled } from "@/lib/config/auth-methods";
import { isPasswordAuthAllowed } from "@/lib/config/provider-restrictions";
import { ACCOUNT_LINKING, secondFactorEverywhere } from "@/lib/auth/second-factor";

// GitHub OAuth credentials from system_settings, cached because Better Auth reads them at init.
let _cachedGitHubClientId = process.env.GITHUB_CLIENT_ID ?? "";
let _cachedGitHubClientSecret = process.env.GITHUB_CLIENT_SECRET ?? "";
let _authInstance: ReturnType<typeof buildAuth> | null = null;
let _dbCredentialsLoaded = false;

/** Updates the cached GitHub OAuth credentials and rebuilds auth on next access. */
export function refreshGitHubOAuthCredentials(clientId: string, clientSecret: string) {
  _cachedGitHubClientId = clientId;
  _cachedGitHubClientSecret = clientSecret;
  _authInstance = null;
}

/** Loads GitHub OAuth credentials from the database when env vars don't set them. */
export async function ensureGitHubCredentials() {
  if (_dbCredentialsLoaded) return;
  _dbCredentialsLoaded = true;

  if (_cachedGitHubClientId && _cachedGitHubClientSecret) return;

  try {
    const { getGitHubAppConfig } = await import("@/lib/system-settings");
    const config = await getGitHubAppConfig();
    if (config?.clientId && config?.clientSecret) {
      _cachedGitHubClientId = config.clientId;
      _cachedGitHubClientSecret = config.clientSecret;
      _authInstance = null;
    }
  } catch {
    // DB may not be ready yet; GitHub OAuth stays off until it is.
  }
}

/** Rebuilds auth on next access. Call after writing to auth_methods. */
export function refreshAuthMethods() {
  _authInstance = null;
}

// Email endpoints stay open while the instance has no users, since the first user signs up with a password.
let _setupPending = false;

/** Re-reads whether the instance still has no users. */
export async function refreshSetupState() {
  const { needsSetup } = await import("@/lib/setup");
  _setupPending = await needsSetup().catch(() => false);
  _authInstance = null;
}

/** Whether first-user signup is still pending, so password endpoints stay open. */
export function isSetupPending() {
  return _setupPending;
}

function passwordEnabled() {
  return _setupPending || (isPasswordAuthAllowed() && isAuthMethodEnabled("password"));
}

function magicLinkPlugin() {
  return magicLink({
    sendMagicLink: async ({ email, url }) => {
      if (process.env.NODE_ENV === "development") {
        console.log(`\n📧 Magic link for ${email}:\n${url}\n`);
      }

      const { sendEmail } = await import("@/lib/email/send");
      const { MagicLinkEmail } = await import("@/lib/email/templates/magic-link");
      await sendEmail({
        to: email,
        subject: `Sign in to ${DEFAULT_APP_NAME}`,
        template: MagicLinkEmail({ url, email }),
      });
    },
  });
}

function buildAuth() {
  const socialProviders: Record<string, unknown> = {};
  if (isAuthMethodEnabled("github") && _cachedGitHubClientId && _cachedGitHubClientSecret) {
    socialProviders.github = {
      clientId: _cachedGitHubClientId,
      clientSecret: _cachedGitHubClientSecret,
    };
  }

  // A disabled method's plugin is left out, so its endpoints don't exist.
  const plugins = [
    ...(isAuthMethodEnabled("passkey") ? [passkey()] : []),
    ...(isAuthMethodEnabled("totp") ? [twoFactor({ issuer: "Vardo" }), secondFactorEverywhere()] : []),
    ...(isAuthMethodEnabled("magic-link") ? [magicLinkPlugin()] : []),
  ] as [ReturnType<typeof passkey>, ReturnType<typeof twoFactor>, ReturnType<typeof magicLinkPlugin>];

  return betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      passkey: schema.passkey,
      twoFactor: schema.twoFactor,
    },
    usePlural: false,
  }),
  logger: {
    level: "debug",
  },

  emailAndPassword: {
    enabled: passwordEnabled(),
    minPasswordLength: 8,
    revokeSessionsOnPasswordReset: true,
  },

  plugins,

  // Exposes isAppAdmin on the session user.
  user: {
    additionalFields: {
      isAppAdmin: {
        type: "boolean",
        defaultValue: false,
        input: false,
      },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 24 hours
  },

  socialProviders,

  account: {
    accountLinking: ACCOUNT_LINKING,
    // Rows stored before this was on are encrypted at startup (lib/auth/oauth-tokens.ts).
    encryptOAuthTokens: true,
  },

  // Every sign-up path (password, magic link, OAuth) creates users through here.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!(await setupTokenAllowsSignup())) {
            throw new APIError("FORBIDDEN", { message: SETUP_TOKEN_MESSAGE });
          }
          if (!(await registrationAllowed(user))) {
            throw new APIError("FORBIDDEN", { message: REGISTRATION_CLOSED_MESSAGE });
          }
        },
        after: async (user) => {
          if (await shouldCreateDefaultOrg()) {
            await createDefaultOrgForUser(user.id, user.name, user.email);
          }
          if (_setupPending) await refreshSetupState();
        },
      },
    },
  },

  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
  },
});
}

// Lazy singleton, rebuilt by refreshGitHubOAuthCredentials() and refreshAuthMethods().
type AuthInstance = ReturnType<typeof buildAuth>;

function getAuthInstance(): AuthInstance {
  if (!_authInstance) {
    _authInstance = buildAuth();
  }
  return _authInstance;
}

export const auth = new Proxy({} as AuthInstance, {
  get(_target, prop) {
    return Reflect.get(getAuthInstance(), prop, getAuthInstance());
  },
  has(_target, prop) {
    return Reflect.has(getAuthInstance(), prop);
  },
});

export type Auth = typeof auth;
