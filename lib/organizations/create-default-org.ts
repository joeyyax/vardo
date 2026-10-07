import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ROLES } from "@/lib/auth/permissions";

/** Create a new user's default org with them as owner. The first user also becomes app admin. */
export async function createDefaultOrgForUser(
  userId: string,
  userName: string | null,
  userEmail: string,
) {
  await db.transaction(async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(schema.user);
    if (Number(count) === 1) {
      await tx
        .update(schema.user)
        .set({ isAppAdmin: true })
        .where(eq(schema.user.id, userId));
    }

    const rawName = userName || userEmail.split("@")[0];
    // Strip +suffix, dots and underscores become spaces, capitalize.

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
