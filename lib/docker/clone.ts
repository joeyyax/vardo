// Creates group environments by fanning out app environments, each with an env snapshot.

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
} from "@/lib/domain-monitoring/auto-domain";
import { getBaseDomain } from "@/lib/domain-monitoring/base-domain";
import { snapshotEnv } from "@/lib/env/environment-env";

type CreateGroupEnvironmentOpts = {
  projectId: string;
  organizationId: string;
  name: string;
  type: "staging" | "preview";
  sourceEnvironment?: string;
  /** Limit the environment to these apps. Omitted means every app in the project. */
  appIds?: string[];
  /** Per-app clone strategy and git branch overrides. */
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

/** Create a group environment and an app environment for each member app. */
export async function createGroupEnvironment(
  opts: CreateGroupEnvironmentOpts
): Promise<GroupEnvironmentResult> {
  const { projects } = await import("@/lib/db/schema");
  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, opts.projectId),
      eq(projects.organizationId, opts.organizationId)
    ),
  });

  if (!project) throw new Error("Project not found");

  const { organizations } = await import("@/lib/db/schema");
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.organizationId),
    columns: { baseDomain: true },
  });
  const baseDomain = await getBaseDomain(org?.baseDomain);

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
      ? generatePreviewSubdomain(app.name, opts.prNumber, baseDomain)
      : generateEnvironmentSubdomain(app.name, opts.name, baseDomain);

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

    // No domain row: it would route this hostname to the production deploy.

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

const PREVIEW_ENV_NAME = /^pr-(\d+)$/;

/** What in a preview group isn't positively a preview. Empty means safe to tear down. */
export function previewGroupStrays(groupEnv: {
  name: string;
  type: string;
  prNumber: number | null;
  environments: { name: string; type: string; isDefault?: boolean | null }[];
}): string[] {
  const strays: string[] = [];
  const match = PREVIEW_ENV_NAME.exec(groupEnv.name);
  if (groupEnv.type !== "preview" || !match) strays.push(`group ${groupEnv.name}`);
  else if (groupEnv.prNumber != null && String(groupEnv.prNumber) !== match[1]) {
    strays.push(`group ${groupEnv.name} is PR #${groupEnv.prNumber}`);
  }
  for (const env of groupEnv.environments) {
    if (env.type !== "preview" || env.name !== groupEnv.name || env.isDefault) {
      strays.push(`environment ${env.name} (${env.type})`);
    }
  }
  return strays;
}

/** Delete a group environment with its app environments, env vars, domains and containers. FKs cascade the rows. */
export async function destroyGroupEnvironment(
  groupEnvironmentId: string,
  organizationId: string
): Promise<{ removed: string[] }> {
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

  // Everything under a preview must itself be the PR's preview, or nothing is touched.
  const isPreview = groupEnv.type === "preview";
  if (isPreview) {
    const strays = previewGroupStrays(groupEnv);
    if (strays.length > 0) {
      throw new Error(`Refusing to tear down ${groupEnv.name}: not a preview (${strays.join(", ")})`);
    }
  }

  const removed: string[] = [];
  const failed: string[] = [];

  const { stopProject, stopPreviewEnvironment } = await import("./deploy");
  for (const env of groupEnv.environments) {
    if (!env.app) continue;
    const result =
      isPreview
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
    if (env.domain && !(isPreview && env.app && !env.domain.startsWith(`${env.app.name}-${env.name}.`))) {
      await db
        .delete(domains)
        .where(and(eq(domains.appId, env.appId), eq(domains.domain, env.domain)));
    }
  }

  await db
    .delete(groupEnvironments)
    .where(eq(groupEnvironments.id, groupEnvironmentId));

  return { removed };
}
