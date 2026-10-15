#!/usr/bin/env tsx
// Creates or resets a local app-admin login for browser checks. Refuses outside a local dev database.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function refusal(env: NodeJS.ProcessEnv): string | null {
  if (env.NODE_ENV === "production") return "NODE_ENV is production.";
  if (!env.DATABASE_URL) return "DATABASE_URL is not set.";
  let host: string;
  try {
    host = new URL(env.DATABASE_URL).hostname.toLowerCase();
  } catch {
    return "DATABASE_URL is not a valid URL.";
  }
  const local = LOCAL_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".test");
  return local ? null : `DATABASE_URL host "${host}" is not local.`;
}

async function main(): Promise<number> {
  const reason = refusal(process.env);
  if (reason) {
    console.error(`[dev-admin] Refusing to run: ${reason}`);
    return 1;
  }

  const email = (process.env.DEV_ADMIN_EMAIL || "dev-admin@localhost.test").trim().toLowerCase();
  const password = process.env.DEV_ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    console.error("[dev-admin] DEV_ADMIN_PASSWORD must be set to at least 8 characters.");
    return 1;
  }

  const { and, asc, eq } = await import("drizzle-orm");
  const { nanoid } = await import("nanoid");
  const { db } = await import("../lib/db");
  const schema = await import("../lib/db/schema");
  const { auth } = await import("../lib/auth");
  const { ROLES } = await import("../lib/auth/permissions");
  const { needsSetup } = await import("../lib/setup");

  const hash = await (await auth.$context).password.hash(password);

  await db.transaction(async (tx) => {
    const existing = await tx.query.user.findFirst({ where: eq(schema.user.email, email) });
    const userId = existing?.id ?? nanoid();
    const fields = { emailVerified: true, isAppAdmin: true, updatedAt: new Date() };

    if (existing) {
      await tx.update(schema.user).set(fields).where(eq(schema.user.id, userId));
    } else {
      await tx.insert(schema.user).values({ id: userId, email, name: "Dev Admin", ...fields });
    }

    const credential = and(eq(schema.account.userId, userId), eq(schema.account.providerId, "credential"));
    const [account] = await tx.select({ id: schema.account.id }).from(schema.account).where(credential);
    if (account) {
      await tx.update(schema.account).set({ password: hash, updatedAt: new Date() }).where(credential);
    } else {
      await tx.insert(schema.account).values({ id: nanoid(), accountId: userId, providerId: "credential", userId, password: hash });
    }

    const [member] = await tx.select({ id: schema.memberships.id }).from(schema.memberships).where(eq(schema.memberships.userId, userId)).limit(1);
    if (!member) {
      const [org] = await tx.select({ id: schema.organizations.id }).from(schema.organizations).orderBy(asc(schema.organizations.createdAt)).limit(1);
      let organizationId = org?.id;
      if (!organizationId) {
        organizationId = nanoid();
        await tx.insert(schema.organizations).values({ id: organizationId, name: "Dev Admin", slug: `dev-admin-${nanoid(8)}` });
      }
      await tx.insert(schema.memberships).values({ id: nanoid(), userId, organizationId, role: ROLES.OWNER });
    }
  });

  // Latches first-run setup shut now that an account exists.
  await needsSetup();

  console.log(`[dev-admin] Ready: ${email}`);
  return 0;
}

if (process.argv[1]?.endsWith("dev-admin.ts")) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[dev-admin] Failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    },
  );
}
