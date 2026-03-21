import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { apps, projects, tags } from "@/lib/db/schema";
import { getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { eq, desc, asc, sql, isNull, and } from "drizzle-orm";
import { Plus } from "lucide-react";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { AppGrid } from "./app-grid";

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
          orderBy: (d: any, { desc }: any) => [desc(d.startedAt)],
          limit: 1,
        },
        appTags: {
          with: { tag: true },
        },
        project: {
          columns: { id: true, name: true, displayName: true, color: true },
        },
      },
    }),
    db.query.tags.findMany({
      where: eq(tags.organizationId, orgId),
      orderBy: [asc(tags.name)],
    }),
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      columns: { id: true, name: true, displayName: true, color: true },
    }),
  ]);

  // Projects that have no apps assigned
  const projectIdsWithApps = new Set(appList.map((a) => a.projectId).filter(Boolean));
  const emptyProjects = projectList.filter((p) => !projectIdsWithApps.has(p.id));

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <div className="flex items-center gap-3">
            <Button asChild>
              <Link href="/projects/new">
                <Plus className="mr-1.5 size-4" />
                New Project
              </Link>
            </Button>
            <Link
              href="/apps/new"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              New App
            </Link>
          </div>
        }
      >
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
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <p className="text-sm text-muted-foreground">
            No projects yet. Create your first project to get started.
          </p>
          <Button size="sm" asChild>
            <Link href="/projects/new">
              <Plus className="mr-1.5 size-4" />
              New Project
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
