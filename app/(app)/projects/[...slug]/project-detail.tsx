"use client";

import Link from "next/link";
import { Plus, Pencil, Rocket } from "lucide-react";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { detectProjectIcon } from "@/lib/ui/project-icon";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProjectApp = {
  id: string;
  name: string;
  displayName: string;
  status: string;
  imageName: string | null;
  gitUrl: string | null;
  deployType: string;
  source: string;
  domains: { domain: string; isPrimary: boolean | null }[];
  deployments: {
    id: string;
    status: string;
    startedAt: Date;
    finishedAt: Date | null;
  }[];
};

type Project = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  color: string | null;
  apps: ProjectApp[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusDotColor(status: string) {
  return status === "active"
    ? "bg-status-success"
    : status === "error"
      ? "bg-status-error"
      : status === "deploying"
        ? "bg-status-info"
        : "bg-status-neutral";
}

function AppIcon({ app, color }: { app: ProjectApp; color: string }) {
  const icon = detectProjectIcon(app);

  if (!icon) {
    return (
      <div
        className="size-10 shrink-0 rounded-md flex items-center justify-center"
        style={{ backgroundColor: `${color}20` }}
      >
        <span
          className="size-2.5 rounded-full"
          style={{ backgroundColor: color }}
        />
      </div>
    );
  }

  return (
    <div
      className="size-10 shrink-0 rounded-md flex items-center justify-center"
      style={{ backgroundColor: `${color}10` }}
    >
      <img src={icon} alt="" className="size-6 opacity-70" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// App Card
// ---------------------------------------------------------------------------

function AppCard({ app, color }: { app: ProjectApp; color: string }) {
  const primaryDomain = app.domains.find((d) => d.isPrimary)?.domain ||
    app.domains[0]?.domain;

  return (
    <Link
      href={`/apps/${app.name}`}
      className="squircle flex items-center gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
    >
      <AppIcon app={app} color={color} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold truncate">
            {app.displayName}
          </h3>
          <span
            className={`size-2 shrink-0 rounded-full ${statusDotColor(app.status)}`}
          />
        </div>
        {primaryDomain && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {primaryDomain}
          </p>
        )}
        {!primaryDomain && (
          <p className="text-xs text-muted-foreground/40 truncate mt-0.5">
            {app.imageName ||
              app.gitUrl
                ?.replace("https://github.com/", "")
                .replace(".git", "") ||
              app.deployType}
          </p>
        )}
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// ProjectDetail
// ---------------------------------------------------------------------------

export function ProjectDetail({
  project,
  orgId,
}: {
  project: Project;
  orgId: string;
}) {
  const color = project.color || "#6366f1";

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <div className="flex items-center gap-2">
            {project.apps.length > 0 && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/projects/${project.name}/deploy`}>
                  <Rocket className="mr-1.5 size-4" />
                  Deploy All
                </Link>
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link href={`/projects/${project.name}/edit`}>
                <Pencil className="mr-1.5 size-4" />
                Edit
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href={`/apps/new?project=${project.id}`}>
                <Plus className="mr-1.5 size-4" />
                Add App
              </Link>
            </Button>
          </div>
        }
      >
        <div className="flex items-center gap-3">
          <span
            className="size-3 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.displayName}
          </h1>
        </div>
      </PageToolbar>

      {project.description && (
        <p className="text-muted-foreground">{project.description}</p>
      )}

      {project.apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <p className="text-sm text-muted-foreground">
            No apps yet. Add your first app to this project.
          </p>
          <Button size="sm" asChild>
            <Link href={`/apps/new?project=${project.id}`}>
              <Plus className="mr-1.5 size-4" />
              Add App
            </Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {project.apps.map((app) => (
            <AppCard key={app.id} app={app} color={color} />
          ))}
        </div>
      )}
    </div>
  );
}
