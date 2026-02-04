import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import { twoFactor, magicLink } from "better-auth/plugins";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      // Map schema tables to Better Auth's expected table names
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
      passkey: schema.passkeys,
      twoFactor: schema.twoFactors,
    },
  }),

  // OAuth providers
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },

  plugins: [
    // Passkey authentication (WebAuthn)
    passkey(),

    // Two-factor authentication (TOTP only, no SMS)
    twoFactor({
      issuer: "Time Tracker",
      // TOTP is enabled by default
      // Backup codes are enabled by default
    }),

    // Magic link authentication
    magicLink({
      sendMagicLink: async ({ email, token, url }) => {
        // TODO: Implement with Resend once email templates are ready
        // For now, log to console in development
        if (process.env.NODE_ENV === "development") {
          console.log(`Magic link for ${email}: ${url}`);
          console.log(`Token: ${token}`);
        }

        // Production implementation:
        // import { Resend } from "resend";
        // const resend = new Resend(process.env.RESEND_API_KEY);
        // await resend.emails.send({
        //   from: "Time Tracker <noreply@yourdomain.com>",
        //   to: email,
        //   subject: "Sign in to Time Tracker",
        //   html: `<a href="${url}">Click here to sign in</a>`,
        // });
      },
    }),
  ],

  // Session configuration
  session: {
    // Sessions stored in database via Drizzle adapter
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // Update session every 24 hours
  },

  // Account configuration
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["github", "google"],
    },
  },

  // Advanced security options
  advanced: {
    // Generate secure cookies
    useSecureCookies: process.env.NODE_ENV === "production",
  },
});

// Export type for use in other files
export type Auth = typeof auth;
