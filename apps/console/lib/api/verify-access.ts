import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

/**
 * Verify the caller has access to an app within the given org.
 * Returns the app (id only) or null if forbidden/not found.
 */
export async function verifyAppAccess(orgId: string, appId: string) {
  const { organization } = await requireOrg();
  if (organization.id !== orgId) return null;
  const app = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
    columns: { id: true },
  });
  return app;
}
