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
        if (process.env.NODE_ENV === "development") {
          console.log(`\n📧 Magic link for ${email}:\n${url}\n`);
        }

        const { sendEmail } = await import("@/lib/email/send");
        const { MagicLinkEmail } = await import("@/lib/email/templates/magic-link");
        await sendEmail({
          to: email,
          subject: "Sign in to Host",
          template: MagicLinkEmail({ url, email }),
        });
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
