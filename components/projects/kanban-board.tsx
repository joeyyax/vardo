"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Archive, Bug, Paperclip, User, Users } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  TaskDialog,
  type Task,
  type TaskStatus,
  TASK_STATUS_LABELS,
  TASK_STATUS_COLORS,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_COLORS,
} from "./task-dialog";
import { cn } from "@/lib/utils";

export type KanbanTask = Task & {
  project?: {
    id: string;
    name: string;
    client: {
      id: string;
      name: string;
      color: string | null;
    };
  };
};

export const KANBAN_COLUMNS: TaskStatus[] = ["todo", "in_progress", "review", "done"];

type AssigneeFilter = "all" | "mine" | "unassigned";

type KanbanBoardProps = {
  orgId: string;
  currentUserId?: string;
  // Project mode: board fetches its own data and manages the task dialog
  projectId?: string;
  // Global mode: parent provides tasks and handles dialog
  tasks?: KanbanTask[];
  onRefresh?: () => void;
  onNewTask?: (status: TaskStatus) => void;
  onEditTask?: (task: KanbanTask) => void;
  onProjectClick?: (projectId: string) => void;
};

export function KanbanBoard({
  orgId,
  currentUserId,
  projectId,
  tasks: externalTasks,
  onRefresh,
  onNewTask: onNewTaskExternal,
  onEditTask: onEditTaskExternal,
  onProjectClick,
}: KanbanBoardProps) {
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [isLoading, setIsLoading] = useState(!externalTasks);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>("all");

  // Drag state
  const [draggedTask, setDraggedTask] = useState<KanbanTask | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);

  // Dialog state (project mode only)
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<KanbanTask | null>(null);
  const [defaultStatus, setDefaultStatus] = useState<TaskStatus>("todo");

  // Sync with external tasks when provided
  useEffect(() => {
    if (externalTasks) {
      setTasks(externalTasks);
      setIsLoading(false);
    }
  }, [externalTasks]);

  // Fetch tasks (project mode only)
  const fetchTasks = useCallback(async () => {
    if (!projectId) return;
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks?forKanban=true`
      );

      if (!response.ok) {
        throw new Error("Failed to fetch tasks");
      }

      const data = await response.json();
      setTasks(data.filter((t: Task) => t.status !== null));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId]);

  useEffect(() => {
    if (projectId && !externalTasks) fetchTasks();
  }, [fetchTasks, projectId, externalTasks]);

  function refetch() {
    if (onRefresh) {
      onRefresh();
    } else if (projectId) {
      fetchTasks();
    }
  }

  function handleNewTask(status: TaskStatus) {
    if (onNewTaskExternal) {
      onNewTaskExternal(status);
    } else {
      setSelectedTask(null);
      setDefaultStatus(status);
      setDialogOpen(true);
    }
  }

  function handleEditTask(task: KanbanTask) {
    if (onEditTaskExternal) {
      onEditTaskExternal(task);
    } else {
      setSelectedTask(task);
      setDialogOpen(true);
    }
  }

  // Drag handlers
  function handleDragStart(e: React.DragEvent, task: KanbanTask) {
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

    if (!draggedTask || draggedTask.status === newStatus) return;

    const taskProjectId = projectId || draggedTask.project?.id || draggedTask.projectId;

    // Optimistically update the UI
    setTasks((prev) =>
      prev.map((t) =>
        t.id === draggedTask.id ? { ...t, status: newStatus } : t
      )
    );

    // Update on server
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${taskProjectId}/tasks/${draggedTask.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: newStatus }),
        }
      );

      if (!response.ok) {
        refetch();
      } else if (externalTasks) {
        // Global mode: tell parent to sync after successful update
        onRefresh?.();
      }
    } catch {
      refetch();
    }
  }

  // Apply assignee filter
  const filteredTasks = useMemo(() => {
    switch (assigneeFilter) {
      case "mine":
        return tasks.filter((t) => t.assignedTo === currentUserId);
      case "unassigned":
        return tasks.filter((t) => !t.assignedTo);
      default:
        return tasks;
    }
  }, [tasks, assigneeFilter, currentUserId]);

  // Group filtered tasks by status
  const tasksByStatus = KANBAN_COLUMNS.reduce(
    (acc, status) => {
      acc[status] = filteredTasks.filter((t) => t.status === status);
      return acc;
    },
    {} as Record<TaskStatus, KanbanTask[]>
  );

  if (isLoading) {
    return (
      <div className="grid grid-cols-4 gap-4">
        {KANBAN_COLUMNS.map((status) => (
          <div key={status} className="space-y-3">
            <div className="h-8 animate-pulse rounded bg-muted" />
            <div className="h-24 animate-pulse rounded-lg border bg-muted/50" />
            <div className="h-24 animate-pulse rounded-lg border bg-muted/50" />
          </div>
        ))}
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
          onClick={fetchTasks}
          className="mt-4 squircle"
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <>
      {/* Assignee filter */}
      <div className="flex items-center gap-2 mb-4">
        <ToggleGroup
          type="single"
          value={assigneeFilter}
          onValueChange={(v) => v && setAssigneeFilter(v as AssigneeFilter)}
          size="sm"
        >
          <ToggleGroupItem value="all" aria-label="All tasks" className="gap-1.5">
            <Users className="size-3.5" />
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="mine" aria-label="My tasks" className="gap-1.5">
            <User className="size-3.5" />
            Mine
          </ToggleGroupItem>
          <ToggleGroupItem value="unassigned" aria-label="Unassigned tasks" className="gap-1.5">
            Unassigned
          </ToggleGroupItem>
        </ToggleGroup>
        {assigneeFilter !== "all" && (
          <span className="text-xs text-muted-foreground">
            {filteredTasks.length} of {tasks.length} tasks
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 min-h-[400px]">
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
                <div className="flex flex-col items-center justify-center h-24 rounded-lg border-2 border-dashed border-muted-foreground/20 text-sm text-muted-foreground/60">
                  <span>No tasks</span>
                  <span className="text-xs">Drop here or click +</span>
                </div>
              ) : (
                tasksByStatus[status].map((task) => (
                  <KanbanCard
                    key={task.id}
                    task={task}
                    onClick={() => handleEditTask(task)}
                    onDragStart={(e) => handleDragStart(e, task)}
                    onDragEnd={handleDragEnd}
                    onProjectClick={onProjectClick}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Internal dialog for project mode (when parent doesn't handle dialog) */}
      {projectId && !onEditTaskExternal && (
        <TaskDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          task={selectedTask}
          orgId={orgId}
          projectId={projectId}
          onSuccess={refetch}
          pmEnabled={true}
          defaultStatus={defaultStatus}
          currentUserId={currentUserId}
        />
      )}
    </>
  );
}

function KanbanCard({
  task,
  onClick,
  onDragStart,
  onDragEnd,
  onProjectClick,
}: {
  task: KanbanTask;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onProjectClick?: (projectId: string) => void;
}) {
  const isBugReport = task.metadata?.source === "widget" || !!task.metadata?.bugReportId;
  const hasFiles = (task.files?.length ?? 0) > 0;
  const assignee = task.assignedToUser;
  const typeBadge = task.type;
  const priority = task.priority;
  const hasBadges = typeBadge || isBugReport || priority;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onClick}
        className="squircle group flex flex-col gap-2 rounded-lg border bg-card p-3 cursor-pointer active:cursor-grabbing transition-all hover:shadow-sm hover:border-foreground/20"
      >
        {/* Badge row: type, priority, bug */}
        {hasBadges && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {priority && (
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
                  TASK_PRIORITY_COLORS[priority]
                )}
              >
                {TASK_PRIORITY_LABELS[priority]}
              </span>
            )}
            {typeBadge && (
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none"
                style={{
                  backgroundColor: typeBadge.color ? `${typeBadge.color}20` : undefined,
                  color: typeBadge.color || undefined,
                }}
              >
                {typeBadge.icon && <span className="text-[10px]">{typeBadge.icon}</span>}
                {typeBadge.name}
              </span>
            )}
            {isBugReport && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium leading-none text-red-600 dark:text-red-400">
                    <Bug className="size-2.5" />
                    Bug
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">From bug report</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}

        {/* Task name */}
        <span className="font-medium text-sm leading-tight">
          {task.name}
        </span>

        {/* Description */}
        {task.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {task.description}
          </p>
        )}

        {/* Project link (shown in global mode when task has project info) */}
        {task.project && onProjectClick && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onProjectClick(task.project!.id);
            }}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors self-start"
          >
            <div
              className="size-2 rounded-full"
              style={{ backgroundColor: task.project.client.color || "#94a3b8" }}
            />
            <span className="truncate">
              {task.project.client.name} / {task.project.name}
            </span>
          </button>
        )}

        {/* Footer: indicators + assignee */}
        <div className="flex items-center gap-2 mt-auto pt-1">
          {task.isArchived && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Archive className="size-3 text-amber-600 dark:text-amber-400" />
              </TooltipTrigger>
              <TooltipContent side="top">Archived</TooltipContent>
            </Tooltip>
          )}
          {hasFiles && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                  <Paperclip className="size-3" />
                  <span className="text-[10px]">{task.files!.length}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {task.files!.length} attachment{task.files!.length !== 1 ? "s" : ""}
              </TooltipContent>
            </Tooltip>
          )}

          {/* Spacer to push assignee right */}
          <div className="flex-1" />

          {assignee && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center justify-center size-5 rounded-full bg-primary/10 text-[10px] font-medium text-primary shrink-0">
                  {(assignee.name || assignee.email)[0].toUpperCase()}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {assignee.name || assignee.email}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
