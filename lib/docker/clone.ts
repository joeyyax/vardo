// ---------------------------------------------------------------------------
// Environment cloning
//
// Creates group-level environments (staging/preview) by fanning out
// app-level environments and cloning env vars with updated refs.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import {
  apps,
  envVars,
  environments,
  groupEnvironments,
  domains,
} from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  generateEnvironmentSubdomain,
  generatePreviewSubdomain,
  getBaseDomain,
} from "@/lib/domain-monitoring/auto-domain";
import { extractExpressions, validateExpression } from "@/lib/env/resolve";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CreateGroupEnvironmentOpts = {
  projectId: string;
  organizationId: string;
  name: string;
  type: "staging" | "preview";
  sourceEnvironment?: string;
  /** Per-app overrides for clone strategy and git branch */
  appOverrides?: Record<
    string,
    { strategy?: string; gitBranch?: string }
  >;
  prNumber?: number;
  prUrl?: string;
  createdBy?: string;
  expiresAt?: Date;
};

type GroupEnvironmentResult = {
  groupEnvironmentId: string;
  projectEnvironments: {
    appId: string;
    appName: string;
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
 * Create a group-level environment and fan out app-level environments
 * for each member app in the project.
 */
export async function createGroupEnvironment(
  opts: CreateGroupEnvironmentOpts
): Promise<GroupEnvironmentResult> {
  // Verify project exists and belongs to org
  const { projects } = await import("@/lib/db/schema");
  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, opts.projectId),
      eq(projects.organizationId, opts.organizationId)
    ),
  });

  if (!project) throw new Error("Project not found");

  // Load org for base domain, fall back to instance config
  const { organizations } = await import("@/lib/db/schema");
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.organizationId),
    columns: { baseDomain: true },
  });
  if (!org?.baseDomain) {
    const { getInstanceConfig } = await import("@/lib/system-settings");
    const instanceConfig = await getInstanceConfig();
    if (instanceConfig.baseDomain && org) {
      (org as { baseDomain: string | null }).baseDomain = instanceConfig.baseDomain;
    }
  }

  // Create group environment record
  const groupEnvId = nanoid();
  await db.insert(groupEnvironments).values({
    id: groupEnvId,
    projectId: opts.projectId,
    name: opts.name,
    type: opts.type,
    sourceEnvironment: opts.sourceEnvironment ?? "production",
    prNumber: opts.prNumber,
    prUrl: opts.prUrl,
    createdBy: opts.createdBy,
    expiresAt: opts.expiresAt,
  });

  // Load all apps in the project
  const projectApps = await db.query.apps.findMany({
    where: eq(apps.projectId, opts.projectId),
  });

  const projectEnvironments: GroupEnvironmentResult["projectEnvironments"] = [];

  // Build a map of app name -> new environment ID for ref updates
  const appEnvMap = new Map<string, string>();
  for (const app of projectApps) {
    appEnvMap.set(app.name, nanoid());
  }

  // Build domain replacement map: production domain → preview domain
  // Used during env var cloning to rewrite domain references automatically.
  const domainReplacements = new Map<string, string>();
  if (opts.type === "preview" && opts.prNumber) {
    for (const app of projectApps) {
      const previewDomain = generatePreviewSubdomain(
        app.name,
        opts.prNumber,
        org?.baseDomain
      );
      // Load production domains for this app
      const appDomains = await db.query.domains.findMany({
        where: eq(domains.appId, app.id),
      });
      for (const d of appDomains) {
        if (d.domain && previewDomain) {
          domainReplacements.set(d.domain, previewDomain);
        }
      }
    }
  } else if (opts.type === "staging") {
    for (const app of projectApps) {
      const stagingDomain = generateEnvironmentSubdomain(
        app.name,
        opts.name,
        org?.baseDomain
      );
      const appDomains = await db.query.domains.findMany({
        where: eq(domains.appId, app.id),
      });
      for (const d of appDomains) {
        if (d.domain && stagingDomain) {
          domainReplacements.set(d.domain, stagingDomain);
        }
      }
    }
  }

  for (const app of projectApps) {
    const override = opts.appOverrides?.[app.id];
    const strategy = override?.strategy ?? app.cloneStrategy ?? "clone";

    // Skip apps marked as skip
    if (strategy === "skip") {
      projectEnvironments.push({
        appId: app.id,
        appName: app.name,
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
        app.name,
        opts.prNumber,
        org?.baseDomain
      );
    } else {
      envDomain = generateEnvironmentSubdomain(
        app.name,
        opts.name,
        org?.baseDomain
      );
    }

    // Create app-level environment
    const envId = appEnvMap.get(app.name)!;
    const envType = opts.type === "preview" ? "preview" : "staging";

    await db.insert(environments).values({
      id: envId,
      appId: app.id,
      name: opts.name,
      type: envType,
      domain: envDomain,
      gitBranch: override?.gitBranch || undefined,
      groupEnvironmentId: groupEnvId,
    });

    // Create domain record
    if (envDomain) {
      await db.insert(domains).values({
        id: nanoid(),
        appId: app.id,
        domain: envDomain,
        isPrimary: false,
        sslEnabled: true,
      });
    }

    // Clone env vars from source (base vars, environmentId = NULL)
    const sourceVars = await db.query.envVars.findMany({
      where: and(
        eq(envVars.appId, app.id),
        isNull(envVars.environmentId)
      ),
    });

    // Clone vars, rewriting any domain references to point to the
    // environment-specific domains (e.g. agents.yax.me → agents-pr-166.yax.me)
    let clonedCount = 0;
    for (const sourceVar of sourceVars) {
      let clonedValue = sourceVar.value;
      for (const [prodDomain, envDomain2] of domainReplacements) {
        clonedValue = clonedValue.replaceAll(prodDomain, envDomain2);
      }

      await db.insert(envVars).values({
        id: nanoid(),
        appId: app.id,
        key: sourceVar.key,
        value: clonedValue,
        isSecret: sourceVar.isSecret,
        environmentId: envId,
      });
      clonedCount++;
    }

    projectEnvironments.push({
      appId: app.id,
      appName: app.name,
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
 * Delete a group environment and all associated app environments,
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
  // Load the group environment with its app environments
  const groupEnv = await db.query.groupEnvironments.findFirst({
    where: eq(groupEnvironments.id, groupEnvironmentId),
    with: {
      project: {
        columns: { organizationId: true },
      },
      environments: {
        with: {
          app: {
            columns: { id: true, name: true },
          },
        },
      },
    },
  });

  if (!groupEnv) throw new Error("Group environment not found");
  if (groupEnv.project.organizationId !== organizationId) {
    throw new Error("Forbidden");
  }

  const removed: string[] = [];

  // Stop containers for each app environment
  const { stopProject } = await import("./deploy");
  for (const env of groupEnv.environments) {
    if (env.app) {
      try {
        await stopProject(env.app.id, env.app.name);
        removed.push(env.app.name);
      } catch {
        // Container may already be stopped
        removed.push(env.app.name);
      }
    }

    // Clean up domain records for this environment
    if (env.domain) {
      await db
        .delete(domains)
        .where(
          and(
            eq(domains.appId, env.appId),
            eq(domains.domain, env.domain)
          )
        );
    }
  }

  // Delete group environment (cascades to app environments and their env vars)
  await db
    .delete(groupEnvironments)
    .where(eq(groupEnvironments.id, groupEnvironmentId));

  return { removed };
}
