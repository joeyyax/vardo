import { db } from "@/lib/db";
import { clients, projects, organizations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { OrgFeatures } from "@/lib/db/schema";

/**
 * Resolve the default assignee for a new entity by walking up the ownership chain.
 * Returns the first non-null assignedTo found, or null if nobody is assigned.
 */
export async function resolveAssignee(opts: {
  explicit?: string | null;
  projectId?: string | null;
  clientId?: string | null;
  orgId: string;
}): Promise<string | null> {
  // Explicit assignment always wins
  if (opts.explicit) return opts.explicit;

  // Walk up: project → client → org default
  if (opts.projectId) {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, opts.projectId),
      columns: { assignedTo: true, clientId: true },
    });
    if (project?.assignedTo) return project.assignedTo;
    // Fall through to client
    if (project?.clientId) {
      const client = await db.query.clients.findFirst({
        where: eq(clients.id, project.clientId),
        columns: { assignedTo: true },
      });
      if (client?.assignedTo) return client.assignedTo;
    }
  } else if (opts.clientId) {
    const client = await db.query.clients.findFirst({
      where: eq(clients.id, opts.clientId),
      columns: { assignedTo: true },
    });
    if (client?.assignedTo) return client.assignedTo;
  }

  // Org default
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.orgId),
    columns: { features: true },
  });
  const features = org?.features as OrgFeatures | null;
  return features?.defaultAssignee ?? null;
}
