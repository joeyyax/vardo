import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { projects, tags, groups } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, desc, asc } from "drizzle-orm";
import { Plus } from "lucide-react";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { ProjectGrid } from "./project-grid";

export default async function ProjectsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;

  const [projectList, tagList, groupList] = await Promise.all([
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      orderBy: [desc(projects.createdAt)],
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
        projectGroups: {
          with: { group: true },
        },
      },
    }),
    db.query.tags.findMany({
      where: eq(tags.organizationId, orgId),
      orderBy: [asc(tags.name)],
    }),
    db.query.groups.findMany({
      where: eq(groups.organizationId, orgId),
      orderBy: [asc(groups.name)],
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <Button size="sm" asChild>
            <Link href="/projects/new">
              <Plus className="mr-1.5 size-4" />
              New Project
            </Link>
          </Button>
        }
      >
        <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
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
          allGroups={groupList}
        />
      )}
    </div>
  );
}
