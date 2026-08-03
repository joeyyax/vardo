import { db } from "@/lib/db";
import { groupEnvironments, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { McpAuthContext } from "../auth";
import { canAccessOrg } from "../scope";

export interface OrgPreview {
  id: string;
  name: string;
  prNumber: number | null;
  prUrl: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  projectId: string;
  organizationId: string;
}

/**
 * Fetch a preview environment and confirm the token may act on the
 * organization that owns it.
 */
export async function resolveOrgPreview(
  previewId: string,
  context: McpAuthContext
): Promise<OrgPreview | null> {
  const row = await db
    .select({
      id: groupEnvironments.id,
      name: groupEnvironments.name,
      prNumber: groupEnvironments.prNumber,
      prUrl: groupEnvironments.prUrl,
      expiresAt: groupEnvironments.expiresAt,
      createdAt: groupEnvironments.createdAt,
      projectId: groupEnvironments.projectId,
      organizationId: projects.organizationId,
    })
    .from(groupEnvironments)
    .innerJoin(projects, eq(groupEnvironments.projectId, projects.id))
    .where(eq(groupEnvironments.id, previewId))
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  if (!(await canAccessOrg(context, row.organizationId))) return null;

  return row;
}

export function previewNotFound() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: "Preview not found or access denied" }),
      },
    ],
    isError: true as const,
  };
}
