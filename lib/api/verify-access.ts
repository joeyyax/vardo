import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { can, INSTANCE_ADMIN_CAPABILITIES, type Capability } from "@/lib/auth/permissions";
import { isAppAdmin } from "@/lib/auth/admin";
import { eq, and } from "drizzle-orm";

/** Org access when the caller's role holds `cap` (instance admins also hold backup caps), else null. */
export async function verifyOrgAccess(orgId: string, cap: Capability) {
  const { organization, membership, session } = await requireOrg();
  if (organization.id !== orgId) return null;
  const instanceAdmin = INSTANCE_ADMIN_CAPABILITIES.has(cap) && (await isAppAdmin());
  if (!can(membership.role, cap, { instanceAdmin })) return null;
  return { organization, membership, session };
}

/** The app when the caller holds `cap` on it, else null. */
export async function verifyAppAccess(orgId: string, appId: string, cap: Capability) {
  const org = await verifyOrgAccess(orgId, cap);
  if (!org) return null;
  const app = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
    columns: { id: true, isSystemManaged: true },
  });
  return app;
}
