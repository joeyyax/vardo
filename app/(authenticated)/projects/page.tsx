import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { apps, projects, tags } from "@/lib/db/schema";
import { getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { eq, desc, asc, isNull, and, type AnyColumn } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { AppGrid } from "./app-grid";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectsActions } from "./projects-actions";

export default async function ProjectsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;
  const organizations = await getUserOrganizations();

  const [appList, tagList, projectList] = await Promise.all([
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
          columns: { id: true, displayName: true, status: true },
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
  ]);

  // Projects that have no apps assigned
  const projectIdsWithApps = new Set(appList.map((a) => a.projectId).filter(Boolean));
  const emptyProjects = projectList.filter((p) => !projectIdsWithApps.has(p.id));

  return (
    <div className="space-y-6">
      <PageToolbar actions={<ProjectsActions />}>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <OrgSwitcher
            currentOrgId={orgId}
            organizations={organizations}
            collapsed={false}
          />
        </div>
      </PageToolbar>

      {appList.length === 0 && emptyProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
          <div className="text-center space-y-1">
            <p className="text-sm font-medium">
              Create your first project
            </p>
            <p className="text-sm text-muted-foreground">
              Projects organize your apps. Create a project, then add apps to it.
            </p>
          </div>
          <Button asChild>
            <Link href="/projects/new">
              <Plus className="mr-1.5 size-4" />
              New project
            </Link>
          </Button>
        </div>
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
