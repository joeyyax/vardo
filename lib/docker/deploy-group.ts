// ---------------------------------------------------------------------------
// Group deploy orchestration
//
// Deploys all projects in a group in dependency order, resolving cross-project
// env var references within the group's environment context.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import {
  projects,
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
  parentProjectId: string;
  organizationId: string;
  trigger: "manual" | "webhook" | "api";
  triggeredBy?: string;
  /** Deploy to a specific group environment (staging/preview). Null = production. */
  groupEnvironmentId?: string;
  onLog?: (projectName: string, line: string) => void;
  onStage?: (
    projectName: string,
    stage: string,
    status: "running" | "success" | "failed" | "skipped"
  ) => void;
  onTier?: (tier: number, projectNames: string[]) => void;
  signal?: AbortSignal;
};

type GroupDeployResult = {
  success: boolean;
  results: {
    projectId: string;
    projectName: string;
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

type ProjectNode = {
  id: string;
  name: string;
  parentId: string | null;
  dependsOn: string[];
  inferredDeps: string[];
};

/**
 * Build the dependency graph for projects in a group.
 * Combines inferred deps (from ${project.VAR} refs) with explicit depends_on.
 */
async function buildDependencyGraph(
  groupProjects: {
    id: string;
    name: string;
    parentId: string | null;
    dependsOn: string[] | null;
  }[],
  environmentId: string | null
): Promise<Map<string, ProjectNode>> {
  const graph = new Map<string, ProjectNode>();
  const projectNames = new Set(groupProjects.map((p) => p.name));

  // Batch-fetch all env vars for all projects in a single query (avoids N+1)
  const allProjectIds = groupProjects.map((p) => p.id);
  const allVars = await db.query.envVars.findMany({
    where: and(
      inArray(envVars.projectId, allProjectIds),
      environmentId
        ? or(eq(envVars.environmentId, environmentId), isNull(envVars.environmentId))
        : isNull(envVars.environmentId)
    ),
  });
  // Group by projectId
  const varsByProject = new Map<string, typeof allVars>();
  for (const v of allVars) {
    const list = varsByProject.get(v.projectId) || [];
    list.push(v);
    varsByProject.set(v.projectId, list);
  }

  for (const project of groupProjects) {
    const projectVars = varsByProject.get(project.id) || [];
    const allVarValues = projectVars.map((v) => v.value);

    // Infer dependencies from cross-project refs
    const inferredDeps = new Set<string>();
    for (const value of allVarValues) {
      for (const expr of extractExpressions(value)) {
        const { type, target } = validateExpression(expr);
        if (type === "cross-project") {
          const refProject = target.split(".")[0];
          if (projectNames.has(refProject) && refProject !== project.name) {
            inferredDeps.add(refProject);
          }
        }
      }
    }

    // Merge explicit depends_on (filter to projects in the group)
    const explicitDeps = (project.dependsOn ?? []).filter(
      (d) => projectNames.has(d) && d !== project.name
    );

    graph.set(project.name, {
      id: project.id,
      name: project.name,
      parentId: project.parentId,
      dependsOn: [...new Set([...inferredDeps, ...explicitDeps])],
      inferredDeps: [...inferredDeps],
    });
  }

  return graph;
}

/**
 * Topological sort into deployment tiers.
 * Projects in the same tier can deploy in parallel.
 * Returns tiers in order (tier 0 has no deps, tier 1 depends on tier 0, etc).
 */
function topologicalTierSort(
  graph: Map<string, ProjectNode>
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
        `Circular dependency detected among group projects: ${unresolved}`
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
 * Deploy all projects in a group in dependency order.
 * Projects within the same tier are deployed in parallel.
 */
export async function deployGroup(
  opts: GroupDeployOpts
): Promise<GroupDeployResult> {
  const startTime = Date.now();

  // Load parent project
  const parentProject = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, opts.parentProjectId),
      eq(projects.organizationId, opts.organizationId)
    ),
  });

  if (!parentProject) throw new Error("Parent project not found");

  // Load all projects in the group
  const groupProjects = await db.query.projects.findMany({
    where: and(
      eq(projects.parentId, opts.parentProjectId),
      eq(projects.organizationId, opts.organizationId)
    ),
  });

  if (groupProjects.length === 0) {
    return {
      success: true,
      results: [],
      totalDurationMs: Date.now() - startTime,
    };
  }

  // Resolve which project-level environmentId to use for each project
  let projectEnvironmentIds: Map<string, string | undefined> = new Map();
  if (opts.groupEnvironmentId) {
    // Find project-level environments linked to this group environment
    const envs = await db.query.environments.findMany({
      where: eq(environments.groupEnvironmentId, opts.groupEnvironmentId),
    });
    for (const env of envs) {
      projectEnvironmentIds.set(env.projectId, env.id);
    }
  }

  // Build dependency graph
  const firstEnvId = [...projectEnvironmentIds.values()][0] ?? null;
  const graph = await buildDependencyGraph(
    groupProjects.map((p) => ({
      id: p.id,
      name: p.name,
      parentId: p.parentId,
      dependsOn: p.dependsOn as string[] | null,
    })),
    firstEnvId
  );

  // Sort into tiers
  const tiers = topologicalTierSort(graph);

  opts.onLog?.("group", `[group] Deploying "${parentProject.name}" — ${groupProjects.length} project(s), ${tiers.length} tier(s)`);
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

    // Deploy all projects in this tier in parallel
    const tierResults = await Promise.allSettled(
      tier.map(async (projectName) => {
        const node = graph.get(projectName)!;
        const envId = projectEnvironmentIds.get(node.id);

        const result = await deployProject({
          projectId: node.id,
          organizationId: opts.organizationId,
          trigger: opts.trigger,
          triggeredBy: opts.triggeredBy,
          environmentId: envId,
          groupEnvironmentId: opts.groupEnvironmentId,
          onLog: (line) => opts.onLog?.(projectName, line),
          onStage: (stage, status) => opts.onStage?.(projectName, stage, status),
          signal: opts.signal,
        });

        return {
          projectId: node.id,
          projectName,
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
        const projectName = tier[tierResults.indexOf(result)];
        const node = graph.get(projectName)!;
        results.push({
          projectId: node.id,
          projectName,
          deploymentId: "",
          success: false,
          durationMs: 0,
          tier: tierIdx,
        });
        allSuccess = false;
        opts.onLog?.(projectName, `[deploy] FATAL: ${result.reason}`);
      }
    }

    // If any project in this tier failed, abort remaining tiers
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
