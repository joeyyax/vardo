import { db } from "@/lib/db";
import { groupEnvironments, projects } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import type { McpAuthContext } from "../auth";
import type { Capability } from "@/lib/auth/permissions";
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
  context: McpAuthContext,
  cap: Capability
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
    .where(and(eq(groupEnvironments.id, previewId), eq(groupEnvironments.type, "preview")))
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  if (!(await canAccessOrg(context, row.organizationId, cap))) return null;

  return row;
}

/** The error every preview tool returns while previews are off, or null when they're on. */
export async function previewsDisabled() {
  if (await isFeatureEnabledAsync("previews")) return null;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: "Previews are not enabled on this instance" }),
      },
    ],
    isError: true as const,
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
