// The Projects screen's model: sections, nesting, ordering and the panel's lists. No React.

import type { AppCondition } from "@/lib/docker/conditions";
import type { ExitReason } from "@/lib/docker/exit-reason";
import {
  PROBLEM_GROUP_ORDER,
  PROBLEM_GROUPS,
  problem,
  problemRank,
  type Problem,
  type ProblemGroup,
  type ProblemGroupMeta,
  type ProblemSubject,
} from "@/lib/ui/conditions";
import { NESTED_KINDS, type ServiceKind } from "@/lib/ui/service-kind";

export type ProjectsDeployment = {
  id: string;
  status: string;
  trigger: string | null;
  gitSha: string | null;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  durationMs: number | null;
};

/** One app or compose service as the page loads it. */
export type ProjectsApp = {
  id: string;
  name: string;
  displayName: string;
  projectId: string;
  status: string;
  parked: boolean;
  kind: ServiceKind;
  conditions: AppCondition[] | null;
  exitReason: ExitReason | null;
  needsRedeploy: boolean | null;
  imageName: string | null;
  gitUrl: string | null;
  composeService: string | null;
  dependsOn: string[] | null;
  priority: "critical" | "standard" | "disposable" | null;
  gpuEnabled: boolean;
  containerStartedAt: Date | string | null;
  lastRunningAt: Date | string | null;
  statusChangedAt: Date | string | null;
  restartCount: number | null;
  /** Primary first. */
  domains: string[];
  tags: string[];
  /** Newest first. A service has none; its parent deploys it. */
  deployments: ProjectsDeployment[];
  /** Finish time of the newest successful backup. */
  lastBackupAt: Date | string | null;
  /** Compose services. */
  services: ProjectsApp[];
};

export type ProjectsProject = {
  id: string;
  name: string;
  displayName: string;
  isSystemManaged: boolean;
};

/** How a nested row hangs off the row above it. */
export type Relation = "service" | "dependency";

export type TreeNode = {
  app: ProjectsApp;
  relation: Relation | null;
  parent: ProjectsApp | null;
  children: TreeNode[];
};

/** problem() input for an app, with its parent when it is a service. */
export function subjectOf(app: ProjectsApp, parent?: ProjectsApp | null): ProblemSubject {
  return {
    name: app.name,
    status: app.status,
    parked: app.parked,
    conditions: app.conditions,
    exitReason: app.exitReason,
    needsRedeploy: app.needsRedeploy,
    latestDeploy: app.deployments[0] ?? null,
    lastRunningAt: app.lastRunningAt,
    statusChangedAt: app.statusChangedAt,
    parentStatus: parent?.status ?? null,
    serviceCount: app.services.length || undefined,
  };
}

export function problemOf(node: Pick<TreeNode, "app" | "parent" | "relation">): Problem | null {
  return problem(subjectOf(node.app, node.relation === "service" ? node.parent : null));
}

/** The mark input for a node: services and dependencies count toward it. */
export function markSubject(node: TreeNode): ProblemSubject & { children: ProblemSubject[] } {
  return {
    ...subjectOf(node.app, node.relation === "service" ? node.parent : null),
    children: node.children.map((c) => markSubject(c)),
  };
}

/**
 * A project's top-level rows. Compose services always nest under their app. A separate app nests
 * under the one app in the same project that depends on it, when it is a database, cache or worker
 * and doesn't depend back.
 */
export function buildTree(apps: ProjectsApp[]): TreeNode[] {
  const byName = new Map(apps.map((a) => [a.name, a]));
  const owned = new Set<string>();
  const linked = new Map<string, ProjectsApp[]>();

  for (const app of apps) {
    if (app.services.length > 0) continue;
    for (const depName of app.dependsOn ?? []) {
      const dep = byName.get(depName);
      if (!dep || dep === app || owned.has(dep.name) || dep.services.length > 0) continue;
      if (!NESTED_KINDS.has(dep.kind)) continue;
      if ((dep.dependsOn ?? []).includes(app.name)) continue;
      owned.add(dep.name);
      linked.set(app.name, [...(linked.get(app.name) ?? []), dep]);
    }
  }

  const node = (app: ProjectsApp, relation: Relation | null, parent: ProjectsApp | null): TreeNode => {
    const self: TreeNode = { app, relation, parent, children: [] };
    self.children = [
      ...app.services.map((s) => node(s, "service", app)),
      ...(linked.get(app.name) ?? []).map((d) => node(d, "dependency", app)),
    ];
    return self;
  };

  return apps.filter((a) => !owned.has(a.name)).map((a) => node(a, null, null));
}

/** Worst problem rank anywhere in the subtree. */
export function worstRank(node: TreeNode): number {
  return Math.max(problemRank(problemOf(node)), node.app.status === "deploying" ? 10 : 0, ...node.children.map(worstRank));
}

/** Problems first, then deploys, then healthy; stopped on purpose last. Ties by name. */
export function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes]
    .map((n) => ({ ...n, children: sortNodes(n.children) }))
    .sort(
      (a, b) =>
        Number(a.app.parked) - Number(b.app.parked) ||
        worstRank(b) - worstRank(a) ||
        a.app.displayName.localeCompare(b.app.displayName) ||
        a.app.id.localeCompare(b.app.id),
    );
}

/** Every node in the subtree, depth first. */
export function walk(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => [n, ...walk(n.children)]);
}

export type ProjectStats = {
  total: number;
  up: number;
  down: number;
  stopped: number;
  deploying: number;
  issues: number;
  critical: number;
  latestDeploy: (ProjectsDeployment & { appName: string }) | null;
  /** Apps with a backup on record, and how many of those are overdue. */
  backups: number;
  backupsOverdue: number;
  lastBackupAt: Date | string | null;
};

const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);

export function projectStats(nodes: TreeNode[]): ProjectStats {
  const tops = nodes.map((n) => n.app);
  const all = walk(nodes);
  const problems = all.map(problemOf).filter((p): p is Problem => !!p);
  const withBackup = all.filter((n) => n.app.lastBackupAt || problemOf(n)?.group === "backups");
  const latestDeploy =
    tops
      .flatMap((a) => (a.deployments[0] ? [{ ...a.deployments[0], appName: a.name }] : []))
      .sort((a, b) => time(b.startedAt) - time(a.startedAt))[0] ?? null;
  const lastBackupAt =
    all.map((n) => n.app.lastBackupAt).filter(Boolean).sort((a, b) => time(b) - time(a))[0] ?? null;

  return {
    total: tops.length,
    up: tops.filter((a) => a.status === "active" && !a.parked).length,
    down: tops.filter((a) => !a.parked && (a.status === "error" || a.status === "missing")).length,
    stopped: tops.filter((a) => a.parked || a.status === "stopped").length,
    deploying: tops.filter((a) => a.status === "deploying").length,
    issues: problems.length,
    critical: problems.filter((p) => p.tone === "error").length,
    latestDeploy,
    backups: withBackup.length,
    backupsOverdue: problems.filter((p) => p.group === "backups").length,
    lastBackupAt,
  };
}

export type Section = { project: ProjectsProject; nodes: TreeNode[]; stats: ProjectStats };

/** One section per project, worst first. Projects with no apps go last. */
export function buildSections(projects: ProjectsProject[], apps: ProjectsApp[]): Section[] {
  const sections = projects.map((project) => {
    const nodes = sortNodes(buildTree(apps.filter((a) => a.projectId === project.id)));
    return { project, nodes, stats: projectStats(nodes) };
  });
  const weight = (s: Section) =>
    s.nodes.length === 0 ? 4 : s.stats.critical ? 0 : s.stats.issues ? 1 : s.stats.deploying ? 2 : 3;
  return sections.sort(
    (a, b) =>
      weight(a) - weight(b) ||
      b.stats.issues - a.stats.issues ||
      a.project.displayName.localeCompare(b.project.displayName),
  );
}

/** Matches the app, or anything nested under it. */
export function matchesQuery(node: TreeNode, project: ProjectsProject, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const own = [node.app.name, node.app.displayName, node.app.imageName, project.displayName, ...node.app.domains, ...node.app.tags]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return own.includes(q) || node.children.some((c) => matchesQuery(c, project, q));
}

// --- The side panel's lists -------------------------------------------------

/** Lists the Projects page opens itself. Problems open the shared attention panel. */
export const PANEL_KEYS = ["deploying", "running", "stopped"] as const;
export type PanelKey = (typeof PANEL_KEYS)[number];

export const PANEL_TITLE: Record<PanelKey, string> = {
  deploying: "Deploying now",
  running: "Running",
  stopped: "Stopped",
};

export function isPanelKey(value: unknown): value is PanelKey {
  return typeof value === "string" && (PANEL_KEYS as readonly string[]).includes(value);
}

export type Located = { node: TreeNode; project: ProjectsProject };
export type IssueEntry = Located & { problem: Problem };
export type IssueGroupData = { key: ProblemGroup; meta: ProblemGroupMeta; items: IssueEntry[] };

/** Every open problem, grouped by kind, worst group first. Items oldest first within a group. */
export function issueGroups(sections: Section[], only?: ProblemGroup): IssueGroupData[] {
  const entries: IssueEntry[] = [];
  for (const s of sections) {
    for (const node of walk(s.nodes)) {
      const p = problemOf(node);
      if (p && (!only || p.group === only)) entries.push({ node, project: s.project, problem: p });
    }
  }
  return PROBLEM_GROUP_ORDER.map((key) => ({
    key,
    meta: PROBLEM_GROUPS[key],
    items: entries
      .filter((e) => e.problem.group === key)
      .sort(
        (a, b) =>
          (a.problem.since ? time(a.problem.since) : Infinity) - (b.problem.since ? time(b.problem.since) : Infinity) ||
          a.node.app.displayName.localeCompare(b.node.app.displayName),
      ),
  })).filter((g) => g.items.length > 0);
}

/** Top-level apps in a state, per project. */
export function appsIn(sections: Section[], key: "running" | "stopped" | "deploying"): Located[] {
  const test = (a: ProjectsApp) =>
    key === "running"
      ? a.status === "active" && !a.parked
      : key === "stopped"
        ? a.parked || a.status === "stopped"
        : a.status === "deploying";
  return sections.flatMap((s) => s.nodes.filter((n) => test(n.app)).map((node) => ({ node, project: s.project })));
}

export type FleetCounts = {
  apps: number;
  running: number;
  attention: number;
  critical: number;
  deploying: number;
  stopped: number;
  backupsOverdue: number;
};

export function fleetCounts(sections: Section[]): FleetCounts {
  const groups = issueGroups(sections);
  const items = groups.flatMap((g) => g.items);
  return {
    apps: sections.reduce((n, s) => n + s.stats.total, 0),
    running: sections.reduce((n, s) => n + s.stats.up, 0),
    attention: items.length,
    critical: items.filter((i) => i.problem.tone === "error").length,
    deploying: sections.reduce((n, s) => n + s.stats.deploying, 0),
    stopped: sections.reduce((n, s) => n + s.stats.stopped, 0),
    backupsOverdue: items.filter((i) => i.problem.group === "backups").length,
  };
}

/** Finds an app by name anywhere in the sections. */
export function locate(sections: Section[], name: string): Located | null {
  for (const s of sections) {
    const node = walk(s.nodes).find((n) => n.app.name === name);
    if (node) return { node, project: s.project };
  }
  return null;
}

/** The path of app names from the top-level row down to this one. */
export function ancestry(sections: Section[], name: string): string[] {
  for (const s of sections) {
    const path = (nodes: TreeNode[], trail: string[]): string[] | null => {
      for (const n of nodes) {
        const here = [...trail, n.app.name];
        if (n.app.name === name) return here;
        const found = path(n.children, here);
        if (found) return found;
      }
      return null;
    };
    const found = path(s.nodes, []);
    if (found) return found;
  }
  return [];
}
