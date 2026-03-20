import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, desc } from "drizzle-orm";
import { Plus } from "lucide-react";
import { PageToolbar } from "@/components/page-toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge className="border-transparent bg-green-500/15 text-green-700 dark:text-green-400">
          Active
        </Badge>
      );
    case "deploying":
      return (
        <Badge variant="outline" className="animate-pulse">
          Deploying
        </Badge>
      );
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    default:
      return <Badge variant="secondary">Stopped</Badge>;
  }
}

function deployTypeLabel(deployType: string) {
  switch (deployType) {
    case "compose":
      return "Compose";
    case "dockerfile":
      return "Dockerfile";
    case "image":
      return "Image";
    case "static":
      return "Static";
    default:
      return deployType;
  }
}

export default async function ProjectsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const projectList = await db.query.projects.findMany({
    where: eq(projects.organizationId, orgData.organization.id),
    orderBy: [desc(projects.createdAt)],
  });

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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projectList.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="squircle flex flex-col gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 cursor-pointer"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-medium">
                    {project.displayName}
                  </h3>
                  <p className="truncate text-xs text-muted-foreground">
                    {project.name}
                  </p>
                </div>
                <StatusBadge status={project.status} />
              </div>

              {project.description && (
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {project.description}
                </p>
              )}

              <div className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5">
                  {deployTypeLabel(project.deployType)}
                </span>
                <span>
                  {new Date(project.createdAt).toLocaleDateString()}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
