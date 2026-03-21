import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { projects, tags } from "@/lib/db/schema";
import { getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { eq, desc, asc, sql } from "drizzle-orm";
import { Plus } from "lucide-react";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { ProjectGrid } from "./project-grid";

export default async function ProjectsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;
  const organizations = await getUserOrganizations();

  const [projectList, tagList] = await Promise.all([
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      orderBy: [asc(projects.sortOrder), desc(projects.createdAt)],
      with: {
        domains: {
          columns: { domain: true, isPrimary: true },
        },
        deployments: {
          columns: { id: true, status: true, startedAt: true, finishedAt: true },
          orderBy: (d, { desc }) => [desc(d.startedAt)],
          limit: 1,
        },
        projectTags: {
          with: { tag: true },
        },
        parent: {
          columns: { id: true, name: true, color: true },
        },
        children: {
          columns: { id: true, name: true, displayName: true, status: true, imageName: true, gitUrl: true, deployType: true },
          orderBy: (c, { asc }) => [asc(c.sortOrder)],
          with: {
            deployments: {
              columns: { id: true, status: true, finishedAt: true },
              orderBy: (d, { desc }) => [desc(d.startedAt)],
              limit: 1,
            },
            domains: {
              columns: { domain: true },
            },
          },
        },
      },
    }),
    db.query.tags.findMany({
      where: eq(tags.organizationId, orgId),
      orderBy: [asc(tags.name)],
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <Button asChild>
            <Link href="/projects/new">
              <Plus className="mr-1.5 size-4" />
              New Project
            </Link>
          </Button>
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

      {projectList.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <p className="text-sm text-muted-foreground">
            No projects deployed yet. Create your first project to get started.
          </p>
          <Button size="sm" asChild>
            <Link href="/projects/new">
              <Plus className="mr-1.5 size-4" />
              New Project
            </Link>
          </Button>
        </div>
      ) : (
        <ProjectGrid
          projects={projectList}
          allTags={tagList}
          orgId={orgId}
        />
      )}
    </div>
  );
}
