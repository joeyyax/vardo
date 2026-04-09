// ---------------------------------------------------------------------------
// Vardo system organization
//
// A dedicated org for system-managed resources: infrastructure apps
// (cAdvisor, Loki, Promtail) and the Vardo self-management project.
//
// Always created on first boot. Hidden from the UI unless the
// selfManagement feature flag is enabled.
// ---------------------------------------------------------------------------

import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import { organizations, memberships } from "@/lib/db/schema";
import { user } from "@/lib/db/schema/auth";
import { ROLES } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";

const log = logger.child("vardo-org");

export const VARDO_ORG_SLUG = "vardo";

/**
 * Ensure the Vardo system org exists and return its ID.
 * Creates the org and adds the first admin as owner if needed.
 * Safe to call on every startup — all writes are idempotent.
 */
export async function ensureVardoOrg(): Promise<{ id: string } | null> {
  const [org] = await db
    .insert(organizations)
    .values({
      id: nanoid(),
      name: "Vardo",
      slug: VARDO_ORG_SLUG,
      isSystemManaged: true,
    })
    .onConflictDoUpdate({
      target: organizations.slug,
      set: {
        name: "Vardo",
        isSystemManaged: true,
        updatedAt: new Date(),
      },
    })
    .returning({ id: organizations.id });

  if (!org) return null;

  // Ensure the first app admin is a member so they can access it
  // when selfManagement is turned on.
  const admin = await db.query.user.findFirst({
    where: eq(user.isAppAdmin, true),
    columns: { id: true },
  });

  if (admin) {
    const existing = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.organizationId, org.id),
        eq(memberships.userId, admin.id),
      ),
      columns: { id: true },
    });

    if (!existing) {
      await db.insert(memberships).values({
        id: nanoid(),
        userId: admin.id,
        organizationId: org.id,
        role: ROLES.OWNER,
      });
      log.info("Added admin to Vardo org");
    }
  }

  return org;
}
