import { db } from "@/lib/db";
import { clients, projects, tasks } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Represents the billable chain data needed to resolve billable status.
 * Entry can be at client, project, or task level.
 */
export interface BillableChain {
  isBillableOverride: boolean | null;
  task?: {
    isBillable: boolean | null;
  } | null;
  project?: {
    isBillable: boolean | null;
  } | null;
  client: {
    isBillable: boolean | null;
  };
}

/**
 * Resolve the effective billable status for a time entry by walking up the hierarchy:
 * Entry override -> Task -> Project -> Client -> (default true)
 *
 * The first non-null value in the chain wins.
 * If all values are null, defaults to true (billable).
 */
export function resolveEntryBillable(chain: BillableChain): boolean {
  // Entry override takes precedence
  if (chain.isBillableOverride !== null) {
    return chain.isBillableOverride;
  }

  // Task level (if present)
  if (chain.task?.isBillable !== null && chain.task?.isBillable !== undefined) {
    return chain.task.isBillable;
  }

  // Project level (if present)
  if (chain.project?.isBillable !== null && chain.project?.isBillable !== undefined) {
    return chain.project.isBillable;
  }

  // Client level
  if (chain.client.isBillable !== null) {
    return chain.client.isBillable;
  }

  // Default to billable if nothing in the chain specifies otherwise
  return true;
}

/**
 * Verify that a client belongs to the specified organization.
 */
export async function getClientForOrg(clientId: string, orgId: string) {
  const client = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
  });

  if (!client || client.organizationId !== orgId) {
    return null;
  }

  return client;
}

/**
 * Verify that a project belongs to the specified organization (via client).
 * Returns the project with client if valid.
 */
export async function getProjectWithClientForOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: true,
    },
  });

  if (!project || project.client.organizationId !== orgId) {
    return null;
  }

  return project;
}

/**
 * Verify that a task belongs to the specified organization.
 * Returns the task with full chain (project, client) if valid, null otherwise.
 */
export async function getTaskWithChainForOrg(taskId: string, orgId: string) {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    with: {
      project: {
        with: {
          client: true,
        },
      },
    },
  });

  if (!task || task.project.client.organizationId !== orgId) {
    return null;
  }

  return task;
}

/**
 * Validate entry hierarchy and return all the resolved entities.
 * Ensures clientId, projectId (if provided), and taskId (if provided) form a valid chain.
 */
export async function validateEntryHierarchy(
  orgId: string,
  clientId: string,
  projectId?: string | null,
  taskId?: string | null
): Promise<{
  valid: boolean;
  error?: string;
  client?: Awaited<ReturnType<typeof getClientForOrg>>;
  project?: Awaited<ReturnType<typeof getProjectWithClientForOrg>>;
  task?: Awaited<ReturnType<typeof getTaskWithChainForOrg>>;
}> {
  // Validate client
  const client = await getClientForOrg(clientId, orgId);
  if (!client) {
    return { valid: false, error: "Client not found or doesn't belong to organization" };
  }

  // If no project, we're done (client-level entry)
  if (!projectId) {
    if (taskId) {
      return { valid: false, error: "Cannot specify taskId without projectId" };
    }
    return { valid: true, client };
  }

  // Validate project
  const project = await getProjectWithClientForOrg(projectId, orgId);
  if (!project) {
    return { valid: false, error: "Project not found or doesn't belong to organization" };
  }

  // Verify project belongs to the specified client
  if (project.clientId !== clientId) {
    return { valid: false, error: "Project doesn't belong to the specified client" };
  }

  // If no task, we're done (project-level entry)
  if (!taskId) {
    return { valid: true, client, project };
  }

  // Validate task
  const task = await getTaskWithChainForOrg(taskId, orgId);
  if (!task) {
    return { valid: false, error: "Task not found or doesn't belong to organization" };
  }

  // Verify task belongs to the specified project
  if (task.projectId !== projectId) {
    return { valid: false, error: "Task doesn't belong to the specified project" };
  }

  return { valid: true, client, project, task };
}
