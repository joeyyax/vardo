"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  GripVertical,
  Kanban,
  LayoutList,
  Loader2,
  Plus,
  ListTodo,
  Edit,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TaskDialog,
  type Task,
  type TaskStatus,
  TASK_STATUS_LABELS,
  TASK_STATUS_COLORS,
} from "@/components/projects/task-dialog";

type TaskWithProject = Task & {
  project: {
    id: string;
    name: string;
    client: {
      id: string;
      name: string;
      color: string | null;
    };
  };
  assignedToUser?: {
    id: string;
    name: string | null;
    email: string;
  } | null;
};

type Client = {
  id: string;
  name: string;
  color: string | null;
};

type Project = {
  id: string;
  name: string;
  clientId: string;
};

type TaskView = "list" | "board";

const KANBAN_COLUMNS: TaskStatus[] = ["todo", "in_progress", "review", "done"];

type TasksContentProps = {
  orgId: string;
};

export function TasksContent({ orgId }: TasksContentProps) {
  const router = useRouter();
  const [tasks, setTasks] = useState<TaskWithProject[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Filters
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // View
  const [view, setView] = useState<TaskView>("board");

  // Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<TaskWithProject | null>(null);
  const [defaultStatus, setDefaultStatus] = useState<TaskStatus>("todo");
  const [defaultProjectId, setDefaultProjectId] = useState<string | null>(null);

  // Drag state (for board view)
  const [draggedTask, setDraggedTask] = useState<TaskWithProject | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);

  const fetchClients = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/clients`);
      if (response.ok) {
        const data = await response.json();
        setClients(data);
      }
    } catch (err) {
      console.error("Error fetching clients:", err);
    }
  }, [orgId]);

  const fetchProjects = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (clientFilter !== "all") {
        params.set("clientId", clientFilter);
      }
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects?${params}`
      );
      if (response.ok) {
        const data = await response.json();
        setProjects(data);
      }
    } catch (err) {
      console.error("Error fetching projects:", err);
    }
  }, [orgId, clientFilter]);

  const fetchTasks = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("hasStatus", "true"); // Only show work items, not categories

      if (clientFilter !== "all") {
        params.set("clientId", clientFilter);
      }
      if (projectFilter !== "all") {
        params.set("projectId", projectFilter);
      }
      if (statusFilter !== "all") {
        params.set("status", statusFilter);
      }

      const response = await fetch(
        `/api/v1/organizations/${orgId}/tasks?${params}`
      );
      if (response.ok) {
        const data = await response.json();
        setTasks(data);
      }
    } catch (err) {
      console.error("Error fetching tasks:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, clientFilter, projectFilter, statusFilter]);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // Reset project filter when client changes
  useEffect(() => {
    setProjectFilter("all");
  }, [clientFilter]);

  // Filter projects by selected client
  const filteredProjects =
    clientFilter === "all"
      ? projects
      : projects.filter((p) => p.clientId === clientFilter);

  function handleNewTask(status: TaskStatus = "todo") {
    setSelectedTask(null);
    setDefaultStatus(status);
    // If a project is selected, use it as default
    setDefaultProjectId(projectFilter !== "all" ? projectFilter : null);
    setDialogOpen(true);
  }

  function handleEditTask(task: TaskWithProject) {
    setSelectedTask(task);
    setDefaultProjectId(task.project.id);
    setDialogOpen(true);
  }

  function handleSuccess() {
    fetchTasks();
  }

  // Drag handlers for board view
  function handleDragStart(e: React.DragEvent, task: TaskWithProject) {
    setDraggedTask(task);
    e.dataTransfer.effectAllowed = "move";
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.classList.add("opacity-50");
    }
  }

  function handleDragEnd(e: React.DragEvent) {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.classList.remove("opacity-50");
    }
    setDraggedTask(null);
    setDragOverColumn(null);
  }

  function handleDragOver(e: React.DragEvent, status: TaskStatus) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverColumn(status);
  }

  function handleDragLeave() {
    setDragOverColumn(null);
  }

  async function handleDrop(e: React.DragEvent, newStatus: TaskStatus) {
    e.preventDefault();
    setDragOverColumn(null);

    if (!draggedTask || draggedTask.status === newStatus) {
      return;
    }

    // Optimistically update UI
    setTasks((prev) =>
      prev.map((t) =>
        t.id === draggedTask.id ? { ...t, status: newStatus } : t
      )
    );

    // Update on server
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${draggedTask.project.id}/tasks/${draggedTask.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: newStatus }),
        }
      );

      if (!response.ok) {
        fetchTasks();
      }
    } catch {
      fetchTasks();
    }
  }

  // Group tasks by status for board view
  const tasksByStatus = KANBAN_COLUMNS.reduce(
    (acc, status) => {
      acc[status] = tasks.filter((t) => t.status === status);
      return acc;
    },
    {} as Record<TaskStatus, TaskWithProject[]>
  );

  // Group tasks by client/project for list view
  const tasksByProject = tasks.reduce(
    (acc, task) => {
      const key = task.project.id;
      if (!acc[key]) {
        acc[key] = {
          project: task.project,
          tasks: [],
        };
      }
      acc[key].tasks.push(task);
      return acc;
    },
    {} as Record<string, { project: TaskWithProject["project"]; tasks: TaskWithProject[] }>
  );

  return (
    <div className="space-y-4">
      {/* Filters and view toggle */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={clientFilter} onValueChange={setClientFilter}>
            <SelectTrigger className="w-[180px] squircle">
              <SelectValue placeholder="All clients" />
            </SelectTrigger>
            <SelectContent className="squircle">
              <SelectItem value="all">All clients</SelectItem>
              {clients.map((client) => (
                <SelectItem key={client.id} value={client.id}>
                  <div className="flex items-center gap-2">
                    <div
                      className="size-2 rounded-full"
                      style={{ backgroundColor: client.color || "#94a3b8" }}
                    />
                    {client.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="w-[180px] squircle">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent className="squircle">
              <SelectItem value="all">All projects</SelectItem>
              {filteredProjects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {view === "list" && (
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[150px] squircle">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent className="squircle">
                <SelectItem value="all">All statuses</SelectItem>
                {KANBAN_COLUMNS.map((status) => (
                  <SelectItem key={status} value={status}>
                    {TASK_STATUS_LABELS[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(v) => v && setView(v as TaskView)}
            size="sm"
          >
            <ToggleGroupItem value="list" aria-label="List view">
              <LayoutList className="size-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="board" aria-label="Board view">
              <Kanban className="size-4" />
            </ToggleGroupItem>
          </ToggleGroup>

          <Button onClick={() => handleNewTask()} className="squircle">
            <Plus className="size-4" />
            New Task
          </Button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : tasks.length === 0 ? (
        <Card className="squircle">
          <CardContent className="py-12 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
              <ListTodo className="size-6 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-lg font-medium">No tasks yet</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Create tasks to track work across your projects.
            </p>
            <Button onClick={() => handleNewTask()} className="mt-4 squircle">
              <Plus className="size-4" />
              New Task
            </Button>
          </CardContent>
        </Card>
      ) : view === "board" ? (
        /* Kanban board view */
        <div className="grid grid-cols-4 gap-4 min-h-[500px]">
          {KANBAN_COLUMNS.map((status) => (
            <div
              key={status}
              className={cn(
                "flex flex-col rounded-lg border bg-muted/30 transition-colors",
                dragOverColumn === status && "border-primary bg-primary/5"
              )}
              onDragOver={(e) => handleDragOver(e, status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, status)}
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-3 py-2 border-b">
                <div className="flex items-center gap-2">
                  <div
                    className={`size-2.5 rounded-full ${
                      TASK_STATUS_COLORS[status].split(" ")[0]
                    }`}
                  />
                  <span className="text-sm font-medium">
                    {TASK_STATUS_LABELS[status]}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {tasksByStatus[status].length}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleNewTask(status)}
                  className="size-6"
                >
                  <Plus className="size-3" />
                </Button>
              </div>

              {/* Column content */}
              <div className="flex-1 p-2 space-y-2 overflow-y-auto">
                {tasksByStatus[status].length === 0 ? (
                  <div className="flex items-center justify-center h-20 text-sm text-muted-foreground/60">
                    Drop tasks here
                  </div>
                ) : (
                  tasksByStatus[status].map((task) => (
                    <GlobalKanbanCard
                      key={task.id}
                      task={task}
                      onEdit={() => handleEditTask(task)}
                      onDragStart={(e) => handleDragStart(e, task)}
                      onDragEnd={handleDragEnd}
                      onProjectClick={() => router.push(`/projects/${task.project.id}`)}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* List view grouped by project */
        <div className="space-y-6">
          {Object.values(tasksByProject).map(({ project, tasks: projectTasks }) => (
            <Card key={project.id} className="squircle">
              <div className="flex items-center gap-3 px-4 py-3 border-b">
                <div
                  className="size-3 rounded-full"
                  style={{ backgroundColor: project.client.color || "#94a3b8" }}
                />
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => router.push(`/projects/${project.id}`)}
                    className="font-medium hover:underline"
                  >
                    {project.name}
                  </button>
                  <span className="text-muted-foreground text-sm ml-2">
                    {project.client.name}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {projectTasks.length} tasks
                </span>
              </div>
              <CardContent className="p-0">
                <div className="divide-y">
                  {projectTasks.map((task) => (
                    <div
                      key={task.id}
                      className="flex items-center gap-4 px-4 py-3 hover:bg-accent/50 transition-colors cursor-pointer"
                      onClick={() => handleEditTask(task)}
                    >
                      <div
                        className={cn(
                          "size-2 rounded-full",
                          TASK_STATUS_COLORS[task.status!].split(" ")[0]
                        )}
                      />
                      <div className="flex-1 min-w-0">
                        <span className="font-medium">{task.name}</span>
                        {task.description && (
                          <p className="text-sm text-muted-foreground truncate">
                            {task.description}
                          </p>
                        )}
                      </div>
                      <span
                        className={cn(
                          "text-xs px-2 py-0.5 rounded-full",
                          TASK_STATUS_COLORS[task.status!]
                        )}
                      >
                        {TASK_STATUS_LABELS[task.status!]}
                      </span>
                      {task.assignedToUser && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <User className="size-3" />
                          {task.assignedToUser.name || task.assignedToUser.email}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Task dialog - requires a project, so show project selector if none selected */}
      {dialogOpen && defaultProjectId ? (
        <TaskDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          task={selectedTask}
          orgId={orgId}
          projectId={defaultProjectId}
          onSuccess={handleSuccess}
          pmEnabled={true}
          defaultStatus={defaultStatus}
        />
      ) : dialogOpen ? (
        <ProjectSelectorDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          projects={projects}
          clients={clients}
          onSelect={(projectId) => {
            setDefaultProjectId(projectId);
          }}
        />
      ) : null}
    </div>
  );
}

function GlobalKanbanCard({
  task,
  onEdit,
  onDragStart,
  onDragEnd,
  onProjectClick,
}: {
  task: TaskWithProject;
  onEdit: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onProjectClick: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="squircle group flex flex-col gap-2 rounded-lg border bg-card p-3 cursor-grab active:cursor-grabbing transition-all hover:shadow-sm"
    >
      <div className="flex items-start gap-2">
        <GripVertical className="size-4 text-muted-foreground/50 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <span className="font-medium text-sm leading-tight">{task.name}</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="shrink-0 size-6 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <Edit className="size-3" />
            </Button>
          </div>
          {task.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {task.description}
            </p>
          )}
        </div>
      </div>

      {/* Project link */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onProjectClick();
        }}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <div
          className="size-2 rounded-full"
          style={{ backgroundColor: task.project.client.color || "#94a3b8" }}
        />
        <span className="truncate">{task.project.name}</span>
      </button>

      {/* Footer with assignee */}
      {task.assignedToUser && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-auto">
          <div className="flex items-center justify-center size-5 rounded-full bg-muted">
            <User className="size-3" />
          </div>
          <span className="truncate">
            {task.assignedToUser.name || task.assignedToUser.email}
          </span>
        </div>
      )}
    </div>
  );
}

function ProjectSelectorDialog({
  open,
  onOpenChange,
  projects,
  clients,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  clients: Client[];
  onSelect: (projectId: string) => void;
}) {
  const [selectedProject, setSelectedProject] = useState<string>("");

  const getClientColor = (clientId: string) => {
    const client = clients.find((c) => c.id === clientId);
    return client?.color || "#94a3b8";
  };

  const getClientName = (clientId: string) => {
    const client = clients.find((c) => c.id === clientId);
    return client?.name || "";
  };

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm",
        open ? "block" : "hidden"
      )}
      onClick={() => onOpenChange(false)}
    >
      <div
        className="fixed left-[50%] top-[50%] z-50 w-full max-w-md translate-x-[-50%] translate-y-[-50%] squircle border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">Select a project</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Tasks must belong to a project. Select a project to create the task in.
        </p>

        <Select value={selectedProject} onValueChange={setSelectedProject}>
          <SelectTrigger className="w-full squircle">
            <SelectValue placeholder="Choose a project..." />
          </SelectTrigger>
          <SelectContent className="squircle max-h-[300px]">
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                <div className="flex items-center gap-2">
                  <div
                    className="size-2 rounded-full"
                    style={{ backgroundColor: getClientColor(project.clientId) }}
                  />
                  <span>{project.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {getClientName(project.clientId)}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex justify-end gap-2 mt-6">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="squircle"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (selectedProject) {
                onSelect(selectedProject);
              }
            }}
            disabled={!selectedProject}
            className="squircle"
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
