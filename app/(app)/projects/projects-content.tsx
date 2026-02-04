"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  DollarSign,
  FolderKanban,
  Archive,
  Filter,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ProjectDialog,
  type Project,
  type Client,
} from "@/components/projects/project-dialog";

type ProjectsContentProps = {
  orgId: string;
};

export function ProjectsContent({ orgId }: ProjectsContentProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [filterClientId, setFilterClientId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  const fetchClients = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/clients`);
      if (!response.ok) {
        throw new Error("Failed to fetch clients");
      }
      const data = await response.json();
      setClients(data);
    } catch (err) {
      console.error("Error fetching clients:", err);
    }
  }, [orgId]);

  const fetchProjects = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterClientId) {
        params.set("clientId", filterClientId);
      }
      if (showArchived) {
        params.set("includeArchived", "true");
      }

      const url = `/api/v1/organizations/${orgId}/projects${
        params.toString() ? `?${params.toString()}` : ""
      }`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error("Failed to fetch projects");
      }
      const data = await response.json();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }, [orgId, filterClientId, showArchived]);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleNewProject = () => {
    setSelectedProject(null);
    setDialogOpen(true);
  };

  const handleEditProject = (project: Project) => {
    setSelectedProject(project);
    setDialogOpen(true);
  };

  const handleSuccess = () => {
    fetchProjects();
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <div className="h-9 w-48 animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-28 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg border bg-muted/50"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchProjects}
          className="mt-4 squircle"
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {/* Header with filters and new button */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {/* Client filter */}
            <div className="flex items-center gap-2">
              <Filter className="size-4 text-muted-foreground" />
              <Select
                value={filterClientId || "all"}
                onValueChange={(value) =>
                  setFilterClientId(value === "all" ? null : value)
                }
              >
                <SelectTrigger className="squircle w-[180px]">
                  <SelectValue placeholder="All clients" />
                </SelectTrigger>
                <SelectContent className="squircle">
                  <SelectItem value="all">All clients</SelectItem>
                  {clients.map((client) => (
                    <SelectItem key={client.id} value={client.id}>
                      <div className="flex items-center gap-2">
                        <div
                          className="size-2.5 shrink-0 rounded-full ring-1 ring-border"
                          style={{
                            backgroundColor: client.color || "#94a3b8",
                          }}
                        />
                        <span>{client.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Show archived toggle */}
            <div className="flex items-center gap-2">
              <Switch
                id="show-archived"
                checked={showArchived}
                onCheckedChange={setShowArchived}
                size="sm"
              />
              <Label
                htmlFor="show-archived"
                className="cursor-pointer text-sm text-muted-foreground"
              >
                Show archived
              </Label>
            </div>
          </div>

          <Button onClick={handleNewProject} className="squircle">
            <Plus className="size-4" />
            New project
          </Button>
        </div>

        {/* Projects list or empty state */}
        {projects.length === 0 ? (
          <EmptyState
            onNewProject={handleNewProject}
            hasClients={clients.length > 0}
            isFiltered={!!filterClientId || showArchived}
          />
        ) : (
          <div className="space-y-2">
            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                onClick={() => handleEditProject(project)}
              />
            ))}
          </div>
        )}
      </div>

      <ProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        project={selectedProject}
        orgId={orgId}
        clients={clients}
        defaultClientId={filterClientId}
        onSuccess={handleSuccess}
      />
    </>
  );
}

function EmptyState({
  onNewProject,
  hasClients,
  isFiltered,
}: {
  onNewProject: () => void;
  hasClients: boolean;
  isFiltered: boolean;
}) {
  if (isFiltered) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <FolderKanban className="size-6 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-lg font-medium">No projects found</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          No projects match your current filters. Try adjusting your filters or
          create a new project.
        </p>
        <Button onClick={onNewProject} className="mt-6 squircle">
          <Plus className="size-4" />
          New project
        </Button>
      </div>
    );
  }

  if (!hasClients) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <FolderKanban className="size-6 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-lg font-medium">Create a client first</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Projects belong to clients. Head over to the Clients page to create
          your first client, then come back here to add projects.
        </p>
        <Button asChild variant="outline" className="mt-6 squircle">
          <a href="/clients">Go to Clients</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <FolderKanban className="size-6 text-muted-foreground" />
      </div>
      <h3 className="mt-4 text-lg font-medium">No projects yet</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Projects help you organize work within a client. Create your first
        project to start tracking time.
      </p>
      <Button onClick={onNewProject} className="mt-6 squircle">
        <Plus className="size-4" />
        Add your first project
      </Button>
    </div>
  );
}

function ProjectRow({
  project,
  onClick,
}: {
  project: Project;
  onClick: () => void;
}) {
  // Format rate for display (cents to dollars)
  const formattedRate = project.rateOverride
    ? `$${(project.rateOverride / 100).toFixed(2)}/hr`
    : null;

  return (
    <button
      onClick={onClick}
      className="squircle w-full rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div className="flex items-center gap-4">
        {/* Client color indicator */}
        <div
          className="size-3 shrink-0 rounded-full ring-1 ring-border"
          style={{
            backgroundColor: project.client.color || "#94a3b8",
          }}
        />

        {/* Project info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{project.name}</span>
            {project.code && (
              <span className="text-xs text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded">
                {project.code}
              </span>
            )}
            {project.isArchived && (
              <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                <Archive className="size-3" />
                Archived
              </span>
            )}
          </div>
          <div className="text-sm text-muted-foreground truncate">
            {project.client.name}
          </div>
        </div>

        {/* Rate and billable badges */}
        <div className="flex items-center gap-3 shrink-0">
          {formattedRate ? (
            <span className="text-sm text-muted-foreground">{formattedRate}</span>
          ) : (
            <span className="text-sm text-muted-foreground/60">
              Inherited rate
            </span>
          )}

          {/* Billable indicator */}
          {project.isBillable !== null && (
            <div
              className={`flex items-center gap-1 text-xs ${
                project.isBillable
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground"
              }`}
            >
              <DollarSign className="size-3" />
              {project.isBillable ? "Billable" : "Non-billable"}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
