import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Represents the billable chain data needed to resolve billable status.
 * This is the shape returned when fetching a task with its project, client, and org.
 */
export interface BillableChain {
  isBillableOverride: boolean | null;
  task: {
    isBillable: boolean | null;
    project: {
      isBillable: boolean | null;
      client: {
        isBillable: boolean | null;
      };
    };
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

  // Task level
  if (chain.task.isBillable !== null) {
    return chain.task.isBillable;
  }

  // Project level
  if (chain.task.project.isBillable !== null) {
    return chain.task.project.isBillable;
  }

  // Client level
  if (chain.task.project.client.isBillable !== null) {
    return chain.task.project.client.isBillable;
  }

  // Default to billable if nothing in the chain specifies otherwise
  return true;
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
