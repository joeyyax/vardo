import { db } from "@/lib/db";
import {
  DEFAULT_ORG_FEATURES,
  clients,
  memberships,
  organizations,
  projects,
  tasks,
  type OrgFeatures,
} from "@/lib/db/schema";
import { resolveAssignee } from "@/lib/assignment";
import { eq, isNull } from "drizzle-orm";

/**
 * One-time backfill script for entity assignments.
 *
 * Walks the inheritance chain bottom-up:
 * 1. Sets defaultAssignee on single-member orgs that lack one
 * 2. Backfills clients (inherits from org default)
 * 3. Backfills projects (inherits from client -> org)
 * 4. Backfills tasks (inherits from project -> client -> org)
 *
 * Idempotent: only updates rows where assignedTo IS NULL.
 *
 * Run with: npx tsx scripts/backfill-assignments.ts
 */
async function backfill(): Promise<void> {
  console.log("Starting assignment backfill...\n");

  // 1. Set defaultAssignee on single-member orgs that don't have one
  const allOrgs = await db.query.organizations.findMany({
    columns: { id: true, features: true },
  });

  let orgCount = 0;
  for (const org of allOrgs) {
    const features = org.features as OrgFeatures | null;
    if (features?.defaultAssignee) continue;

    const members = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.organizationId, org.id));

    if (members.length === 1) {
      const updatedFeatures: OrgFeatures = {
        ...(features ?? DEFAULT_ORG_FEATURES),
        defaultAssignee: members[0].userId,
      };
      await db
        .update(organizations)
        .set({ features: updatedFeatures })
        .where(eq(organizations.id, org.id));
      orgCount++;
    }
  }
  console.log(
    `Orgs: set defaultAssignee on ${orgCount}/${allOrgs.length} single-member orgs`,
  );

  // 2. Backfill clients (inherits from org default)
  const unassignedClients = await db.query.clients.findMany({
    where: isNull(clients.assignedTo),
    columns: { id: true, organizationId: true },
  });

  let clientCount = 0;
  for (const client of unassignedClients) {
    const assignee = await resolveAssignee({
      orgId: client.organizationId,
    });
    if (assignee) {
      await db
        .update(clients)
        .set({ assignedTo: assignee })
        .where(eq(clients.id, client.id));
      clientCount++;
    }
  }
  console.log(
    `Clients: backfilled ${clientCount}/${unassignedClients.length}`,
  );

  // 3. Backfill projects (inherits from client -> org)
  const unassignedProjects = await db.query.projects.findMany({
    where: isNull(projects.assignedTo),
    columns: { id: true, clientId: true },
    with: { client: { columns: { organizationId: true } } },
  });

  let projectCount = 0;
  for (const project of unassignedProjects) {
    const assignee = await resolveAssignee({
      clientId: project.clientId,
      orgId: project.client.organizationId,
    });
    if (assignee) {
      await db
        .update(projects)
        .set({ assignedTo: assignee })
        .where(eq(projects.id, project.id));
      projectCount++;
    }
  }
  console.log(
    `Projects: backfilled ${projectCount}/${unassignedProjects.length}`,
  );

  // 4. Backfill tasks (inherits from project -> client -> org)
  const unassignedTasks = await db.query.tasks.findMany({
    where: isNull(tasks.assignedTo),
    columns: { id: true, projectId: true },
    with: {
      project: {
        columns: { id: true },
        with: { client: { columns: { organizationId: true } } },
      },
    },
  });

  let taskCount = 0;
  for (const task of unassignedTasks) {
    const assignee = await resolveAssignee({
      projectId: task.projectId,
      orgId: task.project.client.organizationId,
    });
    if (assignee) {
      await db
        .update(tasks)
        .set({ assignedTo: assignee })
        .where(eq(tasks.id, task.id));
      taskCount++;
    }
  }
  console.log(`Tasks: backfilled ${taskCount}/${unassignedTasks.length}`);

  console.log("\nBackfill complete.");
}

backfill()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exit(1);
  });
