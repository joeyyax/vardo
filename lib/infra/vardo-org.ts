// Vardo system organization for system-managed apps. Hidden unless selfManagement is on.

import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import { organizations, memberships, invitations } from "@/lib/db/schema";
import { user } from "@/lib/db/schema/auth";
import { ROLES } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";

const log = logger.child("vardo-org");

export const VARDO_ORG_SLUG = "vardo";

/** Ensure the Vardo system org exists with the instance admins as its members, and return its ID. Idempotent. */
export async function ensureVardoOrg(): Promise<{ id: string } | null> {
  const [org] = await db
    .insert(organizations)
    .values({
      id: nanoid(),
      name: "Vardo",
      slug: VARDO_ORG_SLUG,
      isSystemManaged: true,
      trusted: true,
    })
    .onConflictDoUpdate({
      target: organizations.slug,
      set: {
        name: "Vardo",
        isSystemManaged: true,
        trusted: true,
        updatedAt: new Date(),
      },
    })
    .returning({ id: organizations.id });

  if (!org) return null;

  await reconcileVardoOrgMembers(org.id);

  return org;
}

/** Makes the system org's members exactly the instance admins and revokes its pending invitations. Idempotent. */
export async function reconcileVardoOrgMembers(orgId: string): Promise<void> {
  const admins = await db.query.user.findMany({
    where: eq(user.isAppAdmin, true),
    columns: { id: true, email: true },
    orderBy: (u, { asc }) => [asc(u.createdAt)],
  });

  // Never strip the org when no admin exists to take over.
  if (admins.length === 0) return;

  const adminIds = new Set(admins.map((a) => a.id));
  const members = await db.query.memberships.findMany({
    where: eq(memberships.organizationId, orgId),
    columns: { id: true, userId: true, role: true },
  });

  for (const m of members) {
    if (adminIds.has(m.userId)) continue;
    await db.delete(memberships).where(eq(memberships.id, m.id));
    log.warn(`Removed non-admin user ${m.userId} (${m.role}) from the Vardo org`);
  }

  const kept = members.filter((m) => adminIds.has(m.userId));
  const memberIds = new Set(kept.map((m) => m.userId));
  let hasOwner = kept.some((m) => m.role === ROLES.OWNER);
  for (const admin of admins) {
    if (memberIds.has(admin.id)) continue;
    await db.insert(memberships).values({
      id: nanoid(),
      userId: admin.id,
      organizationId: orgId,
      role: hasOwner ? ROLES.ADMIN : ROLES.OWNER,
    });
    hasOwner = true;
    log.info(`Added instance admin ${admin.email} to the Vardo org`);
  }

  const revoked = await db
    .update(invitations)
    .set({ status: "revoked" })
    .where(
      and(
        eq(invitations.scope, "org"),
        eq(invitations.targetId, orgId),
        eq(invitations.status, "pending"),
      ),
    )
    .returning({ id: invitations.id });
  if (revoked.length > 0) log.warn(`Revoked ${revoked.length} pending invitation(s) to the Vardo org`);
}


/** The Vardo system org's ID, or null before it exists. */
export async function findVardoOrgId(): Promise<string | null> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.slug, VARDO_ORG_SLUG),
    columns: { id: true },
  });
  return org?.id ?? null;
}
