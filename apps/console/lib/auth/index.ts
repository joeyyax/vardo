import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import { magicLink } from "better-auth/plugins";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { DEFAULT_APP_NAME } from "@/lib/constants";

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

  plugins: [
    // Passkey authentication (WebAuthn)
    passkey(),

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

  // Social login providers
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },

  // Account configuration
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["github", "google"],
    },
  },

  // Auto-promote first user to app admin + auto-create default organization
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const { eq } = await import("drizzle-orm");
          const { nanoid } = await import("nanoid");

          await db.transaction(async (tx) => {
            const [{ count }] = await tx
              .select({ count: sql<number>`count(*)` })
              .from(schema.user);
            if (Number(count) === 1) {
              await tx
                .update(schema.user)
                .set({ isAppAdmin: true })
                .where(eq(schema.user.id, user.id));
            }

            // Auto-create a default organization for the new user
            const rawName = user.name || user.email.split("@")[0];
            // Strip +suffix from email local parts, replace dots/underscores
            // with spaces, and capitalize the first letter
            const cleanedName = rawName
              .replace(/\+.*$/, "")
              .replace(/[._]/g, " ")
              .replace(/^\w/, (c: string) => c.toUpperCase());
            const baseSlug = cleanedName
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "");
            const slug = `${baseSlug}-${nanoid(8)}`;

            const orgId = nanoid();
            await tx.insert(schema.organizations).values({
              id: orgId,
              name: cleanedName,
              slug,
            });

            await tx.insert(schema.memberships).values({
              id: nanoid(),
              userId: user.id,
              organizationId: orgId,
              role: "owner",
            });
          });
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
