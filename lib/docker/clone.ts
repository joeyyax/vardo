// ---------------------------------------------------------------------------
// Environment cloning
//
// Creates group-level environments (staging/preview) by fanning out
// app-level environments, each with a snapshot of its app's env.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import {
  apps,
  environments,
  environmentEnv,
  groupEnvironments,
  domains,
} from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  generateEnvironmentSubdomain,
  generatePreviewSubdomain,
  getBaseDomain,
} from "@/lib/domain-monitoring/auto-domain";
import { snapshotEnv } from "@/lib/env/environment-env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CreateGroupEnvironmentOpts = {
  projectId: string;
  organizationId: string;
  name: string;
  type: "staging" | "preview";
  sourceEnvironment?: string;
  /** Limit the environment to these apps. Omitted means every app in the project. */
  appIds?: string[];
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

  const allProjectApps = await db.query.apps.findMany({
    where: eq(apps.projectId, opts.projectId),
  });
  const scope = opts.appIds ? new Set(opts.appIds) : null;
  const projectApps = scope ? allProjectApps.filter((a) => scope.has(a.id)) : allProjectApps;

  const projectEnvironments: GroupEnvironmentResult["projectEnvironments"] = [];

  const strategyOf = (app: (typeof projectApps)[number]) =>
    opts.appOverrides?.[app.id]?.strategy ?? app.cloneStrategy ?? "clone";
  const envDomainOf = (app: (typeof projectApps)[number]) =>
    opts.type === "preview" && opts.prNumber
      ? generatePreviewSubdomain(app.name, opts.prNumber, org?.baseDomain)
      : generateEnvironmentSubdomain(app.name, opts.name, org?.baseDomain);

  // Production hostname -> this environment's hostname, for every app that gets one.
  const cloned = projectApps.filter((app) => strategyOf(app) !== "skip");
  const hostReplacements = new Map<string, string>();
  if (cloned.length > 0) {
    const prodDomains = await db.query.domains.findMany({
      where: inArray(domains.appId, cloned.map((a) => a.id)),
      columns: { appId: true, domain: true },
    });
    const envDomains = new Map(cloned.map((a) => [a.id, envDomainOf(a)]));
    for (const d of prodDomains) {
      const envDomain = envDomains.get(d.appId);
      if (d.domain && envDomain) hostReplacements.set(d.domain, envDomain);
    }
  }

  // Production secret -> its replacement, shared by every `empty` app in this environment.
  const generatedSecrets = new Map<string, string>();

  for (const app of projectApps) {
    const override = opts.appOverrides?.[app.id];
    const strategy = strategyOf(app);

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

    const envDomain = envDomainOf(app);
    const envId = nanoid();
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

    // The hostname lives on the environment only. A domain row would route it
    // to, and strip hand-written labels from, the production deploy.

    const snapshot = snapshotEnv({
      appEnvContent: app.envContent,
      organizationId: opts.organizationId,
      hostReplacements,
      strategy,
      generatedSecrets,
    });
    await db.insert(environmentEnv).values({ environmentId: envId, envContent: snapshot.envContent });

    projectEnvironments.push({
      appId: app.id,
      appName: app.name,
      environmentId: envId,
      domain: envDomain,
      cloneStrategy: strategy,
      envVarCount: snapshot.varCount,
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
 * - environment deletion → environment_env and env_var records (via FK)
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
  const failed: string[] = [];

  const { stopProject, stopPreviewEnvironment } = await import("./deploy");
  for (const env of groupEnv.environments) {
    if (!env.app) continue;
    const result =
      groupEnv.type === "preview"
        ? await stopPreviewEnvironment(env.app.id, env.app.name, env.name)
        : await stopProject(env.app.id, env.app.name, env.name);
    if (result.success) removed.push(env.app.name);
    else failed.push(`${env.app.name}-${env.name}: ${result.log}`);
  }

  // Rows are the only record of what is running. Keep them until every stop lands.
  if (failed.length > 0) {
    throw new Error(`Teardown of ${groupEnv.name} incomplete, records kept:\n${failed.join("\n")}`);
  }

  // Older releases stored the environment's hostname as a domain row on the app.
  for (const env of groupEnv.environments) {
    if (env.domain) {
      await db
        .delete(domains)
        .where(and(eq(domains.appId, env.appId), eq(domains.domain, env.domain)));
    }
  }

  // Delete group environment (cascades to app environments and their env vars)
  await db
    .delete(groupEnvironments)
    .where(eq(groupEnvironments.id, groupEnvironmentId));

  return { removed };
}
