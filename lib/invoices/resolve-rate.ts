import { db } from "@/lib/db";
import { organizations, clients, projects, tasks } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Represents the rate chain data needed to resolve effective rate.
 * Entry can be at client, project, or task level.
 */
export interface RateChain {
  task?: {
    rateOverride: number | null;
  } | null;
  project?: {
    rateOverride: number | null;
  } | null;
  client: {
    rateOverride: number | null;
  };
  organization: {
    defaultRate: number | null;
  };
}

/**
 * Resolve the effective rate (cents/hour) for a time entry by walking up the hierarchy:
 * Task -> Project -> Client -> Organization default
 *
 * The first non-null value in the chain wins.
 * Returns null if no rate is set anywhere in the hierarchy.
 */
export function resolveRate(chain: RateChain): number | null {
  // Task level (if present)
  if (chain.task?.rateOverride !== null && chain.task?.rateOverride !== undefined) {
    return chain.task.rateOverride;
  }

  // Project level (if present)
  if (chain.project?.rateOverride !== null && chain.project?.rateOverride !== undefined) {
    return chain.project.rateOverride;
  }

  // Client level
  if (chain.client.rateOverride !== null) {
    return chain.client.rateOverride;
  }

  // Organization default rate
  return chain.organization.defaultRate;
}

/**
 * Resolve rate for a specific entry based on its hierarchy IDs.
 * Fetches the necessary data and returns the effective rate.
 */
export async function resolveRateForEntry(
  orgId: string,
  clientId: string,
  projectId?: string | null,
  taskId?: string | null
): Promise<number | null> {
  // Get organization
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
    columns: { defaultRate: true },
  });

  if (!org) {
    return null;
  }

  // Get client
  const client = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
    columns: { rateOverride: true },
  });

  if (!client) {
    return null;
  }

  // Build chain starting with org and client
  const chain: RateChain = {
    organization: { defaultRate: org.defaultRate },
    client: { rateOverride: client.rateOverride },
  };

  // Add project if present
  if (projectId) {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      columns: { rateOverride: true },
    });
    if (project) {
      chain.project = { rateOverride: project.rateOverride };
    }
  }

  // Add task if present
  if (taskId) {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { rateOverride: true },
    });
    if (task) {
      chain.task = { rateOverride: task.rateOverride };
    }
  }

  return resolveRate(chain);
}

/**
 * Build a rate chain from already-fetched entities.
 * Useful when you already have the data loaded.
 */
export function buildRateChain(
  organization: { defaultRate: number | null },
  client: { rateOverride: number | null },
  project?: { rateOverride: number | null } | null,
  task?: { rateOverride: number | null } | null
): RateChain {
  return {
    organization,
    client,
    project: project || undefined,
    task: task || undefined,
  };
}
