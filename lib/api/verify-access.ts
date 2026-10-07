import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { can, INSTANCE_ADMIN_CAPABILITIES, type Capability } from "@/lib/auth/permissions";
import { isAppAdmin } from "@/lib/auth/admin";
import { eq, and } from "drizzle-orm";

/**
 * Verify the caller belongs to the given org and their role holds `cap`.
 * An instance admin also holds the backup capabilities in any org they belong to.
 * Returns { organization, membership, session } or null if forbidden.
 */
export async function verifyOrgAccess(orgId: string, cap: Capability) {
  const { organization, membership, session } = await requireOrg();
  if (organization.id !== orgId) return null;
  const instanceAdmin = INSTANCE_ADMIN_CAPABILITIES.has(cap) && (await isAppAdmin());
  if (!can(membership.role, cap, { instanceAdmin })) return null;
  return { organization, membership, session };
}

/**
 * Verify the caller holds `cap` on an app within the given org.
 * Returns the app (id, isSystemManaged) or null if forbidden/not found.
 */
export async function verifyAppAccess(orgId: string, appId: string, cap: Capability) {
  const org = await verifyOrgAccess(orgId, cap);
  if (!org) return null;
  const app = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
    columns: { id: true, isSystemManaged: true },
  });
  return app;
}
