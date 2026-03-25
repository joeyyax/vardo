import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

/**
 * Verify the caller belongs to the given org.
 * Returns { organization, membership, session } or null if forbidden.
 */
export async function verifyOrgAccess(orgId: string) {
  const { organization, membership, session } = await requireOrg();
  if (organization.id !== orgId) return null;
  return { organization, membership, session };
}

/**
 * Verify the caller has access to an app within the given org.
 * Returns the app (id only) or null if forbidden/not found.
 */
export async function verifyAppAccess(orgId: string, appId: string) {
  const org = await verifyOrgAccess(orgId);
  if (!org) return null;
  const app = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
    columns: { id: true },
  });
  return app;
}
