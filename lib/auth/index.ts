import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import { twoFactor, magicLink } from "better-auth/plugins";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

export const auth = betterAuth({
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

  // Email + password authentication
  emailAndPassword: {
    enabled: true,
  },

  plugins: [
    // Passkey authentication (WebAuthn)
    passkey(),

    // Two-factor authentication (TOTP only, no SMS)
    twoFactor({
      issuer: "Host",
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

        // Send via MailPace if API token is configured
        if (process.env.MAILPACE_API_TOKEN) {
          try {
            const res = await fetch("https://app.mailpace.com/api/v1/send", {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "MailPace-Server-Token": process.env.MAILPACE_API_TOKEN,
              },
              body: JSON.stringify({
                from: process.env.EMAIL_FROM || "Host <noreply@usescope.net>",
                to: email,
                subject: "Sign in to Host",
                htmlbody: `
                  <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 40px 20px;">
                    <h2 style="margin-bottom: 24px;">Sign in to Host</h2>
                    <p style="color: #666; margin-bottom: 24px;">Click the button below to sign in. This link expires in 10 minutes.</p>
                    <a href="${url}" style="display: inline-block; background: #000; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">Sign in</a>
                    <p style="color: #999; font-size: 14px; margin-top: 32px;">If you didn't request this, you can safely ignore this email.</p>
                  </div>
                `,
              }),
            });
            if (!res.ok) {
              const body = await res.text();
              console.error("MailPace magic link send failed:", res.status, body);
            }
          } catch (err) {
            console.error("MailPace magic link send error:", err);
          }
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

  // Auto-promote first user to app admin
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const [{ count }] = await db
            .select({ count: sql<number>`count(*)` })
            .from(schema.user);
          if (Number(count) === 1) {
            const { eq } = await import("drizzle-orm");
            await db
              .update(schema.user)
              .set({ isAppAdmin: true })
              .where(eq(schema.user.id, user.id));
          }
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

// Export type for use in other files
export type Auth = typeof auth;
