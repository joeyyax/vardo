import "server-only";

import { and, asc, desc, eq, inArray, isNull, max, type AnyColumn } from "drizzle-orm";
import { db } from "@/lib/db";
import { restartCountsByApp } from "@/lib/db/app-restarts";
import { apps, backups } from "@/lib/db/schema";
import { primaryDomain } from "@/lib/ui/app-row";
import type { ProjectsApp } from "@/lib/ui/projects";
import { effectiveKind } from "@/lib/ui/service-kind";

const APP_COLUMNS = {
  id: true,
  name: true,
  displayName: true,
  projectId: true,
  status: true,
  parked: true,
  kind: true,
  kindOverride: true,
  conditions: true,
  exitReason: true,
  needsRedeploy: true,
  imageName: true,
  gitUrl: true,
  composeService: true,
  dependsOn: true,
  priority: true,
  gpuEnabled: true,
  containerStartedAt: true,
  lastRunningAt: true,
  statusChangedAt: true,
} as const;

const DEPLOYMENT_COLUMNS = {
  id: true,
  status: true,
  trigger: true,
  gitSha: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
} as const;

/** The org's top-level apps shaped for the Projects list, optionally one project's. */
export async function loadProjectsApps(orgId: string, projectId?: string): Promise<ProjectsApp[]> {
  const appList = await db.query.apps.findMany({
    where: and(
      eq(apps.organizationId, orgId),
      isNull(apps.parentAppId),
      projectId ? eq(apps.projectId, projectId) : undefined,
    ),
    orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
    columns: APP_COLUMNS,
    with: {
      domains: { columns: { domain: true, isPrimary: true } },
      deployments: {
        columns: DEPLOYMENT_COLUMNS,
        orderBy: (d: { startedAt: AnyColumn }) => [desc(d.startedAt)],
        limit: 3,
      },
      appTags: { with: { tag: { columns: { name: true } } } },
      childApps: {
        columns: APP_COLUMNS,
        with: { domains: { columns: { domain: true, isPrimary: true } } },
      },
    },
  });

  const ids = appList.flatMap((a) => [a.id, ...a.childApps.map((c) => c.id)]);
  const [restarts, lastBackups] = await Promise.all([
    restartCountsByApp(ids),
    ids.length === 0
      ? Promise.resolve([])
      : db
          .select({ appId: backups.appId, at: max(backups.finishedAt) })
          .from(backups)
          .where(and(eq(backups.organizationId, orgId), eq(backups.status, "success"), inArray(backups.appId, ids)))
          .groupBy(backups.appId),
  ]);
  const lastBackupBy = new Map(lastBackups.map((b) => [b.appId, b.at]));

  type Row = (typeof appList)[number] | (typeof appList)[number]["childApps"][number];
  const shape = (a: Row, extra: Pick<ProjectsApp, "deployments" | "services"> & { tags?: string[] }): ProjectsApp => {
    const primary = primaryDomain(a.domains);
    return {
      ...a,
      kind: effectiveKind(a),
      domains: primary ? [primary, ...a.domains.map((d) => d.domain).filter((d) => d !== primary)] : [],
      restartCount: restarts.get(a.id) ?? null,
      lastBackupAt: lastBackupBy.get(a.id) ?? null,
      tags: extra.tags ?? [],
      deployments: extra.deployments,
      services: extra.services,
    };
  };

  return appList.map((a) =>
    shape(a, {
      deployments: a.deployments,
      tags: a.appTags.map((t) => t.tag.name),
      services: a.childApps.map((c) => shape(c, { deployments: [], services: [] })),
    }),
  );
}
