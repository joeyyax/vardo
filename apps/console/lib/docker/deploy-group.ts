// ---------------------------------------------------------------------------
// Group deploy orchestration
//
// Deploys all apps in a project in dependency order, resolving cross-app
// env var references within the project's environment context.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import {
  apps,
  envVars,
  environments,
  groupEnvironments,
  orgEnvVars,
} from "@/lib/db/schema";
import { eq, and, isNull, inArray, or } from "drizzle-orm";
import { extractExpressions, validateExpression } from "@/lib/env/resolve";
import { deployProject, createDeployment, runDeployment } from "./deploy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GroupDeployOpts = {
  projectId: string;
  organizationId: string;
  trigger: "manual" | "webhook" | "api";
  triggeredBy?: string;
  /** Deploy to a specific group environment (staging/preview). Null = production. */
  groupEnvironmentId?: string;
  onLog?: (appName: string, line: string) => void;
  onStage?: (
    appName: string,
    stage: string,
    status: "running" | "success" | "failed" | "skipped"
  ) => void;
  onTier?: (tier: number, appNames: string[]) => void;
  signal?: AbortSignal;
};

type GroupDeployResult = {
  success: boolean;
  results: {
    appId: string;
    appName: string;
    deploymentId: string;
    success: boolean;
    durationMs: number;
    tier: number;
  }[];
  totalDurationMs: number;
};

export type { GroupDeployOpts, GroupDeployResult };

// ---------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------

type AppNode = {
  id: string;
  name: string;
  projectId: string | null;
  dependsOn: string[];
  inferredDeps: string[];
};

/**
 * Build the dependency graph for apps in a project.
 * Combines inferred deps (from ${app.VAR} refs) with explicit depends_on.
 */
async function buildDependencyGraph(
  projectApps: {
    id: string;
    name: string;
    projectId: string | null;
    dependsOn: string[] | null;
  }[],
  environmentId: string | null
): Promise<Map<string, AppNode>> {
  const graph = new Map<string, AppNode>();
  const appNames = new Set(projectApps.map((a) => a.name));

  // Batch-fetch all env vars for all apps in a single query (avoids N+1)
  const allAppIds = projectApps.map((a) => a.id);
  const allVars = await db.query.envVars.findMany({
    where: and(
      inArray(envVars.appId, allAppIds),
      environmentId
        ? or(eq(envVars.environmentId, environmentId), isNull(envVars.environmentId))
        : isNull(envVars.environmentId)
    ),
  });
  // Group by appId
  const varsByApp = new Map<string, typeof allVars>();
  for (const v of allVars) {
    const list = varsByApp.get(v.appId) || [];
    list.push(v);
    varsByApp.set(v.appId, list);
  }

  for (const app of projectApps) {
    const appVars = varsByApp.get(app.id) || [];
    const allVarValues = appVars.map((v) => v.value);

    // Infer dependencies from cross-app refs
    const inferredDeps = new Set<string>();
    for (const value of allVarValues) {
      for (const expr of extractExpressions(value)) {
        const { type, target } = validateExpression(expr);
        if (type === "cross-project") {
          const refApp = target.split(".")[0];
          if (appNames.has(refApp) && refApp !== app.name) {
            inferredDeps.add(refApp);
          }
        }
      }
    }

    // Merge explicit depends_on (filter to apps in the project)
    const explicitDeps = (app.dependsOn ?? []).filter(
      (d) => appNames.has(d) && d !== app.name
    );

    graph.set(app.name, {
      id: app.id,
      name: app.name,
      projectId: app.projectId,
      dependsOn: [...new Set([...inferredDeps, ...explicitDeps])],
      inferredDeps: [...inferredDeps],
    });
  }

  return graph;
}

/**
 * Topological sort into deployment tiers.
 * Apps in the same tier can deploy in parallel.
 * Returns tiers in order (tier 0 has no deps, tier 1 depends on tier 0, etc).
 */
function topologicalTierSort(
  graph: Map<string, AppNode>
): string[][] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();

  for (const [name, node] of graph) {
    inDegree.set(name, node.dependsOn.length);
    for (const dep of node.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep)!.add(name);
    }
  }

  const tiers: string[][] = [];
  const remaining = new Set(graph.keys());

  while (remaining.size > 0) {
    const tier: string[] = [];
    for (const name of remaining) {
      if ((inDegree.get(name) ?? 0) === 0) {
        tier.push(name);
      }
    }

    if (tier.length === 0) {
      const unresolved = [...remaining].join(", ");
      throw new Error(
        `Circular dependency detected among project apps: ${unresolved}`
      );
    }

    for (const name of tier) {
      remaining.delete(name);
      for (const dependent of dependents.get(name) ?? []) {
        inDegree.set(dependent, (inDegree.get(dependent) ?? 1) - 1);
      }
    }

    tiers.push(tier);
  }

  return tiers;
}

// ---------------------------------------------------------------------------
// Group deploy
// ---------------------------------------------------------------------------

/**
 * Deploy all apps in a project in dependency order.
 * Apps within the same tier are deployed in parallel.
 */
export async function deployGroup(
  opts: GroupDeployOpts
): Promise<GroupDeployResult> {
  const startTime = Date.now();

  // Load project (grouping)
  const { projects } = await import("@/lib/db/schema");
  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, opts.projectId),
      eq(projects.organizationId, opts.organizationId)
    ),
  });

  if (!project) throw new Error("Project not found");

  // Load all top-level apps in the project (exclude compose child services)
  const projectApps = await db.query.apps.findMany({
    where: and(
      eq(apps.projectId, opts.projectId),
      eq(apps.organizationId, opts.organizationId),
      isNull(apps.parentAppId),
    ),
  });

  if (projectApps.length === 0) {
    return {
      success: true,
      results: [],
      totalDurationMs: Date.now() - startTime,
    };
  }

  // Resolve which app-level environmentId to use for each app
  const appEnvironmentIds: Map<string, string | undefined> = new Map();
  if (opts.groupEnvironmentId) {
    // Find app-level environments linked to this group environment
    const envs = await db.query.environments.findMany({
      where: eq(environments.groupEnvironmentId, opts.groupEnvironmentId),
    });
    for (const env of envs) {
      appEnvironmentIds.set(env.appId, env.id);
    }
  }

  // Build dependency graph
  const firstEnvId = [...appEnvironmentIds.values()][0] ?? null;
  const graph = await buildDependencyGraph(
    projectApps.map((a) => ({
      id: a.id,
      name: a.name,
      projectId: a.projectId,
      dependsOn: a.dependsOn as string[] | null,
    })),
    firstEnvId
  );

  // Sort into tiers
  const tiers = topologicalTierSort(graph);

  opts.onLog?.("group", `[group] Deploying "${project.name}" — ${projectApps.length} app(s), ${tiers.length} tier(s)`);
  for (let i = 0; i < tiers.length; i++) {
    opts.onLog?.("group", `[group] Tier ${i}: ${tiers[i].join(", ")}`);
  }

  // Deploy tier by tier
  const results: GroupDeployResult["results"] = [];
  let allSuccess = true;

  for (let tierIdx = 0; tierIdx < tiers.length; tierIdx++) {
    const tier = tiers[tierIdx];
    opts.onTier?.(tierIdx, tier);
    opts.onLog?.("group", `[group] Starting tier ${tierIdx}: ${tier.join(", ")}`);

    if (opts.signal?.aborted) throw new Error("Group deployment aborted");

    // Deploy all apps in this tier in parallel
    const tierResults = await Promise.allSettled(
      tier.map(async (appName) => {
        const node = graph.get(appName)!;
        const envId = appEnvironmentIds.get(node.id);

        const result = await deployProject({
          appId: node.id,
          organizationId: opts.organizationId,
          trigger: opts.trigger,
          triggeredBy: opts.triggeredBy,
          environmentId: envId,
          groupEnvironmentId: opts.groupEnvironmentId,
          onLog: (line) => opts.onLog?.(appName, line),
          onStage: (stage, status) => opts.onStage?.(appName, stage, status),
          signal: opts.signal,
        });

        return {
          appId: node.id,
          appName,
          deploymentId: result.deploymentId,
          success: result.success,
          durationMs: result.durationMs,
          tier: tierIdx,
        };
      })
    );

    for (const result of tierResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
        if (!result.value.success) allSuccess = false;
      } else {
        // Deployment threw an error
        const appName = tier[tierResults.indexOf(result)];
        const node = graph.get(appName)!;
        results.push({
          appId: node.id,
          appName,
          deploymentId: "",
          success: false,
          durationMs: 0,
          tier: tierIdx,
        });
        allSuccess = false;
        opts.onLog?.(appName, `[deploy] FATAL: ${result.reason}`);
      }
    }

    // If any app in this tier failed, abort remaining tiers
    const tierFailed = tierResults.some(
      (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.success)
    );
    if (tierFailed) {
      opts.onLog?.("group", `[group] Tier ${tierIdx} had failures — aborting remaining tiers`);
      break;
    }
  }

  const totalDurationMs = Date.now() - startTime;
  opts.onLog?.("group", `[group] Deploy complete — ${allSuccess ? "SUCCESS" : "FAILED"} in ${Math.round(totalDurationMs / 1000)}s`);

  return { success: allSuccess, results, totalDurationMs };
}
