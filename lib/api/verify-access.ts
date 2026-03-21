import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

/**
 * Verify the caller has access to a project within the given org.
 * Returns the project (id only) or null if forbidden/not found.
 */
export async function verifyProjectAccess(orgId: string, projectId: string) {
  const { organization } = await requireOrg();
  if (organization.id !== orgId) return null;
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
    columns: { id: true },
  });
  return project;
}
