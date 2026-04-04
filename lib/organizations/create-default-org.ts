import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ROLES } from "@/lib/auth/permissions";

/**
 * Create a default organization for a newly registered user and link
 * them as the owner. When the user is the very first account in the
 * system they are also promoted to app-wide admin.
 *
 * Runs inside a transaction to keep the user, organization, and
 * membership rows consistent.
 */
export async function createDefaultOrgForUser(
  userId: string,
  userName: string | null,
  userEmail: string,
) {
  await db.transaction(async (tx) => {
    // If this is the very first user, promote them to app admin
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(schema.user);
    if (Number(count) === 1) {
      await tx
        .update(schema.user)
        .set({ isAppAdmin: true })
        .where(eq(schema.user.id, userId));
    }

    // Derive a human-readable org name from the user's name or email
    const rawName = userName || userEmail.split("@")[0];
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
      userId,
      organizationId: orgId,
      role: ROLES.OWNER,
    });
  });
}
