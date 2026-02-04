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
      sendMagicLink: async ({ email, url }) => {
        // Log to console in development for debugging
        if (process.env.NODE_ENV === "development") {
          console.log(`\n📧 Magic link for ${email}:\n${url}\n`);
        }

        // Send via Resend if API key is configured
        if (process.env.RESEND_API_KEY) {
          const { Resend } = await import("resend");
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: "Time <noreply@resend.dev>",
            to: email,
            subject: "Sign in to Time",
            html: `
              <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 40px 20px;">
                <h2 style="margin-bottom: 24px;">Sign in to Time</h2>
                <p style="color: #666; margin-bottom: 24px;">Click the button below to sign in. This link expires in 10 minutes.</p>
                <a href="${url}" style="display: inline-block; background: #000; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">Sign in</a>
                <p style="color: #999; font-size: 14px; margin-top: 32px;">If you didn't request this, you can safely ignore this email.</p>
              </div>
            `,
          });
        }
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
