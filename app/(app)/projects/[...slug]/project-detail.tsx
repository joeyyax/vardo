"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Plus,
  Pencil,
  Rocket,
  Trash2,
  ChevronDown,
  Check,
  EllipsisVertical,
} from "lucide-react";
import {
  type AppMetrics,
  type MetricKey,
  type MetricsHistory,
  EMPTY_HISTORY,
  Sparkline,
  MetricsLine,
  useAppMetrics,
} from "@/components/app-metrics-card";
import { toast } from "sonner";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { detectProjectIcon } from "@/lib/ui/project-icon";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GroupEnvironment = {
  id: string;
  name: string;
  type: string;
};

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
  groupEnvironments: GroupEnvironment[];
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

function envTypeDotColor(type: string) {
  return type === "production"
    ? "bg-status-success"
    : type === "staging"
      ? "bg-status-warning"
      : "bg-status-info";
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

function AppCard({
  app,
  color,
  metrics,
  history,
}: {
  app: ProjectApp;
  color: string;
  metrics?: AppMetrics;
  history: MetricsHistory;
}) {
  const primaryDomain = app.domains.find((d) => d.isPrimary)?.domain ||
    app.domains[0]?.domain;
  const [hoveredMetric, setHoveredMetric] = useState<MetricKey | null>(null);
  const activeMetric = hoveredMetric || "cpu";

  return (
    <Link
      href={`/apps/${app.name}`}
      className="squircle relative flex items-center gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 overflow-hidden"
    >
      {/* Background sparklines — crossfade on hover */}
      {(["cpu", "memory", "disk", "network"] as MetricKey[]).map((key) => {
        const data = history[key];
        if (data.length === 0) return null;
        return (
          <Sparkline
            key={key}
            data={data}
            className={`absolute inset-0 w-full h-full text-foreground pointer-events-none transition-opacity duration-300 ${
              activeMetric === key ? "opacity-100" : "opacity-0"
            }`}
          />
        );
      })}

      <div className="relative flex items-center gap-3 w-full">
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
          {metrics && <MetricsLine metrics={metrics} onHover={setHoveredMetric} />}
        </div>
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
  const router = useRouter();
  const color = project.color || "#6366f1";
  const { metrics, history } = useAppMetrics(orgId);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedEnv, setSelectedEnv] = useState<string>("production");
  const [newEnvOpen, setNewEnvOpen] = useState(false);
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvSaving, setNewEnvSaving] = useState(false);

  const environments = [
    { name: "production", type: "production" },
    ...project.groupEnvironments.map((e) => ({ name: e.name, type: e.type })),
  ];

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to delete project");
        return;
      }
      toast.success("Project deleted");
      router.push("/projects");
    } catch {
      toast.error("Failed to delete project");
    } finally {
      setDeleting(false);
    }
  }

  async function handleCreateEnv() {
    const name = newEnvName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!name) return;
    setNewEnvSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}/environments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, type: "staging" }),
        }
      );
      if (res.ok) {
        toast.success(`Environment "${name}" created`);
        setNewEnvOpen(false);
        setNewEnvName("");
        setSelectedEnv(name);
        router.refresh();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to create environment");
      }
    } catch {
      toast.error("Failed to create environment");
    } finally {
      setNewEnvSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <div className="flex items-center gap-2">
            {project.apps.length > 0 && (
              <Button size="sm" disabled>
                <Rocket className="mr-1.5 size-4" />
                Deploy All
              </Button>
            )}
            <Button size="sm" asChild>
              <Link href={`/apps/new?project=${project.id}`}>
                <Plus className="mr-1.5 size-4" />
                Add App
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="outline">
                  <EllipsisVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled>
                  <Pencil className="mr-2 size-4" />
                  Edit project
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
          {/* Environment switcher */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <span className={`size-2 rounded-full ${envTypeDotColor(
                  environments.find((e) => e.name === selectedEnv)?.type || "production"
                )}`} />
                {selectedEnv}
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {environments.map((env) => (
                <DropdownMenuItem
                  key={env.name}
                  onClick={() => setSelectedEnv(env.name)}
                >
                  <span className={`mr-2 size-2 rounded-full ${envTypeDotColor(env.type)}`} />
                  {env.name}
                  {env.name === selectedEnv && <Check className="ml-auto size-3.5" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-muted-foreground"
                onClick={() => setNewEnvOpen(true)}
              >
                <Plus className="mr-2 size-3.5" />
                New environment
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
            <AppCard
              key={app.id}
              app={app}
              color={color}
              metrics={metrics.get(app.id)}
              history={history.get(app.id) || EMPTY_HISTORY}
            />
          ))}
        </div>
      )}

      {/* New environment sheet */}
      <BottomSheet open={newEnvOpen} onOpenChange={setNewEnvOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>New Environment</BottomSheetTitle>
            <BottomSheetDescription>
              Create a new environment for all apps in this project.
            </BottomSheetDescription>
          </BottomSheetHeader>
          <div className="p-6 space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="env-name">Name</Label>
              <Input
                id="env-name"
                placeholder="staging, preview, dev..."
                value={newEnvName}
                onChange={(e) => setNewEnvName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateEnv(); }}
                autoFocus
              />
            </div>
          </div>
          <BottomSheetFooter>
            <Button variant="outline" onClick={() => setNewEnvOpen(false)} disabled={newEnvSaving}>
              Cancel
            </Button>
            <Button onClick={handleCreateEnv} disabled={newEnvSaving || !newEnvName.trim()}>
              {newEnvSaving ? "Creating..." : "Create Environment"}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>

      {/* Delete confirmation */}
      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete project"
        description={
          project.apps.length > 0
            ? `This will remove the project "${project.displayName}" but keep its ${project.apps.length} app(s). They will become unassigned.`
            : `Delete the project "${project.displayName}"?`
        }
      />
    </div>
  );
}
