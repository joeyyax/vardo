// Server-scope breakdown: organization, project, app, with Vardo's own services as a group.

import { dedupeByContainer } from "./aggregate";
import {
  containerTotals,
  shapeCoreServices,
  type CoreContainer,
  type CoreSummary,
  type CoreTotals,
} from "./core-services";

/** An app as the server-scope stream reports it. */
export type ServerApp = {
  id: string;
  name: string;
  displayName: string;
  status: string;
  parentAppId?: string | null;
  organizationId: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  isCore?: boolean;
  containers: CoreContainer[];
};

export type AppGroupRow = CoreTotals & {
  id: string;
  name: string;
  appName: string;
  isActive: boolean;
  limit: number;
};

export type ProjectGroup = CoreTotals & { id: string; name: string; apps: AppGroupRow[] };

export type OrgGroup = CoreTotals & { id: string; name: string; projects: ProjectGroup[] };

export type ServerBreakdown = { orgs: OrgGroup[]; core: CoreSummary };

const NO_PROJECT = "none";

function byMemoryDesc<T extends { memory: number; name: string }>(a: T, b: T) {
  return b.memory - a.memory || a.name.localeCompare(b.name);
}

/** Groups apps by organization then project, and sets Vardo's own services apart. Compose children count under their parent. */
export function groupServerApps(apps: ServerApp[]): ServerBreakdown {
  const coreApps = apps.filter((a) => a.isCore);
  const core = shapeCoreServices(dedupeByContainer(coreApps.map((a) => a.containers)));

  const byOrg = new Map<string, { name: string; apps: ServerApp[] }>();
  for (const app of apps) {
    if (app.isCore || !app.organizationId) continue;
    const org = byOrg.get(app.organizationId) ?? { name: app.organizationName ?? app.organizationId, apps: [] };
    org.apps.push(app);
    byOrg.set(app.organizationId, org);
  }

  const orgs = [...byOrg.entries()].map(([id, org]): OrgGroup => {
    const topLevel = org.apps.filter((a) => !a.parentAppId);
    const byProject = new Map<string, { name: string; apps: ServerApp[] }>();
    for (const app of topLevel) {
      const key = app.projectId ?? NO_PROJECT;
      const project = byProject.get(key) ?? { name: app.projectName ?? "No project", apps: [] };
      project.apps.push(app);
      byProject.set(key, project);
    }

    const projects = [...byProject.entries()].map(([pid, project]): ProjectGroup => ({
      id: pid,
      name: project.name,
      ...containerTotals(project.apps.flatMap((a) => a.containers)),
      apps: project.apps
        .map((a): AppGroupRow => ({
          id: a.id,
          name: a.displayName,
          appName: a.name,
          isActive: a.status === "active",
          limit: Math.max(0, ...a.containers.map((c) => c.memoryLimit)),
          ...containerTotals(a.containers),
        }))
        .sort(byMemoryDesc),
    }));

    return {
      id,
      name: org.name,
      ...containerTotals(topLevel.flatMap((a) => a.containers)),
      projects: projects.sort(byMemoryDesc),
    };
  });

  return { orgs: orgs.sort(byMemoryDesc), core };
}
