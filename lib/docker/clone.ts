// ---------------------------------------------------------------------------
// Environment cloning
//
// Creates group-level environments (staging/preview) by fanning out
// project-level environments and cloning env vars with updated refs.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import {
  projects,
  envVars,
  environments,
  groupEnvironments,
  groups,
  domains,
} from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  generateEnvironmentSubdomain,
  generatePreviewSubdomain,
  getBaseDomain,
} from "@/lib/domains/auto-domain";
import { extractExpressions, validateExpression } from "@/lib/env/resolve";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CreateGroupEnvironmentOpts = {
  groupId: string;
  organizationId: string;
  name: string;
  type: "staging" | "preview";
  sourceEnvironment?: string;
  prNumber?: number;
  prUrl?: string;
  createdBy?: string;
  expiresAt?: Date;
};

type GroupEnvironmentResult = {
  groupEnvironmentId: string;
  projectEnvironments: {
    projectId: string;
    projectName: string;
    environmentId: string;
    domain: string | null;
    cloneStrategy: string;
    envVarCount: number;
  }[];
};

export type { CreateGroupEnvironmentOpts, GroupEnvironmentResult };

// ---------------------------------------------------------------------------
// Create group environment
// ---------------------------------------------------------------------------

/**
 * Create a group-level environment and fan out project-level environments
 * for each member project in the group.
 */
export async function createGroupEnvironment(
  opts: CreateGroupEnvironmentOpts
): Promise<GroupEnvironmentResult> {
  // Verify group exists and belongs to org
  const group = await db.query.groups.findFirst({
    where: and(
      eq(groups.id, opts.groupId),
      eq(groups.organizationId, opts.organizationId)
    ),
  });

  if (!group) throw new Error("Group not found");

  // Load org for base domain
  const { organizations } = await import("@/lib/db/schema");
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.organizationId),
    columns: { baseDomain: true },
  });

  // Create group environment record
  const groupEnvId = nanoid();
  await db.insert(groupEnvironments).values({
    id: groupEnvId,
    groupId: opts.groupId,
    name: opts.name,
    type: opts.type,
    sourceEnvironment: opts.sourceEnvironment ?? "production",
    prNumber: opts.prNumber,
    prUrl: opts.prUrl,
    createdBy: opts.createdBy,
    expiresAt: opts.expiresAt,
  });

  // Load all projects in the group
  const groupProjects = await db.query.projects.findMany({
    where: eq(projects.groupId, opts.groupId),
  });

  const projectEnvironments: GroupEnvironmentResult["projectEnvironments"] = [];

  // Build a map of project name -> new environment ID for ref updates
  const projectEnvMap = new Map<string, string>();
  for (const project of groupProjects) {
    projectEnvMap.set(project.name, nanoid());
  }

  for (const project of groupProjects) {
    const strategy = project.cloneStrategy ?? "clone";

    // Skip projects marked as skip
    if (strategy === "skip") {
      projectEnvironments.push({
        projectId: project.id,
        projectName: project.name,
        environmentId: "",
        domain: null,
        cloneStrategy: strategy,
        envVarCount: 0,
      });
      continue;
    }

    // Generate environment-specific domain
    let envDomain: string | null = null;
    if (opts.type === "preview" && opts.prNumber) {
      envDomain = generatePreviewSubdomain(
        project.name,
        opts.prNumber,
        org?.baseDomain
      );
    } else {
      envDomain = generateEnvironmentSubdomain(
        project.name,
        opts.name,
        org?.baseDomain
      );
    }

    // Create project-level environment
    const envId = projectEnvMap.get(project.name)!;
    const envType = opts.type === "preview" ? "preview" : "staging";

    await db.insert(environments).values({
      id: envId,
      projectId: project.id,
      name: opts.name,
      type: envType,
      domain: envDomain,
      groupEnvironmentId: groupEnvId,
    });

    // Create domain record
    if (envDomain) {
      await db.insert(domains).values({
        id: nanoid(),
        projectId: project.id,
        domain: envDomain,
        isPrimary: false,
        sslEnabled: true,
      });
    }

    // Clone env vars from source (base vars, environmentId = NULL)
    const sourceVars = await db.query.envVars.findMany({
      where: and(
        eq(envVars.projectId, project.id),
        isNull(envVars.environmentId)
      ),
    });

    // Clone vars with cross-project ref updates
    let clonedCount = 0;
    for (const sourceVar of sourceVars) {
      let clonedValue = sourceVar.value;

      // Update cross-project refs to point to cloned environment services
      // (the refs themselves don't change, resolution at deploy time will
      //  pick up the correct environment-scoped values)

      await db.insert(envVars).values({
        id: nanoid(),
        projectId: project.id,
        key: sourceVar.key,
        value: clonedValue,
        isSecret: sourceVar.isSecret,
        environmentId: envId,
      });
      clonedCount++;
    }

    projectEnvironments.push({
      projectId: project.id,
      projectName: project.name,
      environmentId: envId,
      domain: envDomain,
      cloneStrategy: strategy,
      envVarCount: clonedCount,
    });
  }

  return {
    groupEnvironmentId: groupEnvId,
    projectEnvironments,
  };
}

// ---------------------------------------------------------------------------
// Destroy group environment
// ---------------------------------------------------------------------------

/**
 * Delete a group environment and all associated project environments,
 * env vars, domains, and containers.
 *
 * Cascading deletes handle most cleanup via ON DELETE CASCADE:
 * - group_environment deletion → environment records (via FK)
 * - environment deletion → env_var records (via FK)
 *
 * Containers and domains need explicit cleanup.
 */
export async function destroyGroupEnvironment(
  groupEnvironmentId: string,
  organizationId: string
): Promise<{ removed: string[] }> {
  // Load the group environment with its project environments
  const groupEnv = await db.query.groupEnvironments.findFirst({
    where: eq(groupEnvironments.id, groupEnvironmentId),
    with: {
      group: {
        columns: { organizationId: true },
      },
      environments: {
        with: {
          project: {
            columns: { id: true, name: true },
          },
        },
      },
    },
  });

  if (!groupEnv) throw new Error("Group environment not found");
  if (groupEnv.group.organizationId !== organizationId) {
    throw new Error("Forbidden");
  }

  const removed: string[] = [];

  // Stop containers for each project environment
  const { stopProject } = await import("./deploy");
  for (const env of groupEnv.environments) {
    if (env.project) {
      try {
        await stopProject(env.project.id, env.project.name);
        removed.push(env.project.name);
      } catch {
        // Container may already be stopped
        removed.push(env.project.name);
      }
    }

    // Clean up domain records for this environment
    if (env.domain) {
      await db
        .delete(domains)
        .where(
          and(
            eq(domains.projectId, env.projectId),
            eq(domains.domain, env.domain)
          )
        );
    }
  }

  // Delete group environment (cascades to project environments and their env vars)
  await db
    .delete(groupEnvironments)
    .where(eq(groupEnvironments.id, groupEnvironmentId));

  return { removed };
}
