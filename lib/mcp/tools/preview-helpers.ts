import { db } from "@/lib/db";
import { groupEnvironments, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export interface OrgPreview {
  id: string;
  name: string;
  prNumber: number | null;
  prUrl: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  projectId: string;
}

/**
 * Fetch a preview environment and verify it belongs to the given org.
 * Returns null if the preview doesn't exist or belongs to a different org.
 */
export async function resolveOrgPreview(
  previewId: string,
  organizationId: string
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

  if (!row || row.organizationId !== organizationId) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    projectId: row.projectId,
  };
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
