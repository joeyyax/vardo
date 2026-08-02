import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { apps, projects, tags } from "@/lib/db/schema";
import { getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { eq, desc, asc, isNull, and, type AnyColumn } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { AppGrid } from "./app-grid";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { FirstRun } from "./first-run";
import { ProjectsActions } from "./projects-actions";

export default async function ProjectsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;
  const organizations = await getUserOrganizations();

  const [appList, tagList, projectList, containerImportEnabled] = await Promise.all([
    db.query.apps.findMany({
      where: and(eq(apps.organizationId, orgId), isNull(apps.parentAppId)),
      orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
      with: {
        domains: {
          columns: { domain: true, isPrimary: true },
        },
        deployments: {
          columns: { id: true, status: true, startedAt: true, finishedAt: true },
          orderBy: (d: { startedAt: AnyColumn }) => [desc(d.startedAt)],
          limit: 1,
        },
        appTags: {
          with: { tag: true },
        },
        project: {
          columns: { id: true, name: true, displayName: true, color: true, isSystemManaged: true },
        },
        childApps: {
          columns: { id: true, displayName: true, status: true, conditions: true },
        },
      },
    }),
    db.query.tags.findMany({
      where: eq(tags.organizationId, orgId),
      orderBy: [asc(tags.name)],
    }),
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      columns: { id: true, name: true, displayName: true, color: true, isSystemManaged: true },
    }),
    isFeatureEnabledAsync("container-import"),
  ]);

  // Projects that have no apps assigned
  const projectIdsWithApps = new Set(appList.map((a) => a.projectId).filter(Boolean));
  const emptyProjects = projectList.filter((p) => !projectIdsWithApps.has(p.id));

  return (
    <div className="space-y-6">
      <PageToolbar actions={<ProjectsActions />}>
        <div className="flex items-center gap-3">
          <h1 className="type-h1">Projects</h1>
          <OrgSwitcher
            currentOrgId={orgId}
            organizations={organizations}
            collapsed={false}
          />
        </div>
      </PageToolbar>

      {appList.length === 0 && emptyProjects.length === 0 ? (
        <FirstRun canImportContainers={containerImportEnabled} />
      ) : (
        <AppGrid
          apps={appList}
          allTags={tagList}
          orgId={orgId}
          emptyProjects={emptyProjects}
        />
      )}
    </div>
  );
}
