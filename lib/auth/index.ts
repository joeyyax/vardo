import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import { twoFactor, magicLink } from "better-auth/plugins";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { DEFAULT_APP_NAME } from "@/lib/constants";
import { createDefaultOrgForUser } from "@/lib/organizations/create-default-org";

// GitHub OAuth credentials are stored in the database (system_settings).
// Better Auth requires credentials at init time, so we cache them and
// rebuild the auth instance when they change. The cache is populated by
// the admin settings API after saving GitHub config.
let _cachedGitHubClientId = process.env.GITHUB_CLIENT_ID ?? "";
let _cachedGitHubClientSecret = process.env.GITHUB_CLIENT_SECRET ?? "";
let _authInstance: ReturnType<typeof buildAuth> | null = null;
let _dbCredentialsLoaded = false;

/**
 * Update the cached GitHub OAuth credentials and force the auth
 * instance to be rebuilt on next access. Call this after saving
 * GitHub App config in the admin UI.
 */
export function refreshGitHubOAuthCredentials(clientId: string, clientSecret: string) {
  _cachedGitHubClientId = clientId;
  _cachedGitHubClientSecret = clientSecret;
  _authInstance = null;
}

/**
 * Load GitHub OAuth credentials from the database if not already loaded
 * and no env vars are set. Called lazily on first auth access.
 */
export async function ensureGitHubCredentials() {
  if (_dbCredentialsLoaded) return;
  _dbCredentialsLoaded = true;

  // If env vars already provide credentials, no need to hit the DB
  if (_cachedGitHubClientId && _cachedGitHubClientSecret) return;

  try {
    const { getGitHubAppConfig } = await import("@/lib/system-settings");
    const config = await getGitHubAppConfig();
    if (config?.clientId && config?.clientSecret) {
      _cachedGitHubClientId = config.clientId;
      _cachedGitHubClientSecret = config.clientSecret;
      _authInstance = null; // Force rebuild with DB credentials
    }
  } catch {
    // DB may not be ready yet (e.g., during migrations). That's fine —
    // GitHub OAuth will simply be unavailable until credentials are loaded.
  }
}

function buildAuth() {
  // Build socialProviders conditionally — only include GitHub if credentials exist
  const socialProviders: Record<string, unknown> = {};
  if (_cachedGitHubClientId && _cachedGitHubClientSecret) {
    socialProviders.github = {
      clientId: _cachedGitHubClientId,
      clientSecret: _cachedGitHubClientSecret,
    };
  }

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

  // Password auth enabled — required for onboarding first-user signup
  // and password-based sign-in on the login page
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },

  plugins: [
    // Passkey authentication (WebAuthn)
    passkey(),

    // Two-factor authentication (TOTP only, no SMS)
    twoFactor({
      issuer: "Vardo",
      // TOTP is enabled by default
      // Backup codes are enabled by default
    }),

    // Magic link authentication
    magicLink({
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
    }),
  ],

  // Expose isAppAdmin on the session user object so callers don't need
  // a separate DB query. This field is already in the user table schema.
  user: {
    additionalFields: {
      isAppAdmin: {
        type: "boolean",
        defaultValue: false,
        input: false,
      },
    },
  },

  // Session configuration
  session: {
    // Sessions stored in database via Drizzle adapter
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // Update session every 24 hours
  },

  // Social login providers — built dynamically based on available credentials
  socialProviders,

  // Account configuration
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["github"],
    },
  },

  // Auto-promote first user to app admin + auto-create default organization
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await createDefaultOrgForUser(user.id, user.name, user.email);
        },
      },
    },
  },

  // Advanced security options
  advanced: {
    // Generate secure cookies
    useSecureCookies: process.env.NODE_ENV === "production",
  },
});
}

// Lazy singleton — rebuilt when GitHub credentials change via refreshGitHubOAuthCredentials()
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

// Export type for use in other files
export type Auth = typeof auth;
