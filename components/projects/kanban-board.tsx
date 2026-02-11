"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Archive, Bug, Paperclip } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

export type KanbanContext = "main" | "client" | "project";

const KANBAN_COLUMNS: TaskStatus[] = ["todo", "in_progress", "review", "done"];

type KanbanBoardProps = {
  orgId: string;
  projectId: string;
  currentUserId?: string;
};

export function KanbanBoard({ orgId, projectId, currentUserId }: KanbanBoardProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Drag state
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [defaultStatus, setDefaultStatus] = useState<TaskStatus>("todo");

  const fetchTasks = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks?forKanban=true`
      );

      if (!response.ok) {
        throw new Error("Failed to fetch tasks");
      }

      const data = await response.json();
      // Only show tasks with a status (not category-only tasks)
      setTasks(data.filter((t: Task) => t.status !== null));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  function handleNewTask(status: TaskStatus) {
    setSelectedTask(null);
    setDefaultStatus(status);
    setDialogOpen(true);
  }

  function handleEditTask(task: Task) {
    setSelectedTask(task);
    setDialogOpen(true);
  }

  function handleSuccess() {
    fetchTasks();
  }

  // Drag handlers
  function handleDragStart(e: React.DragEvent, task: Task) {
    setDraggedTask(task);
    e.dataTransfer.effectAllowed = "move";
    // Add drag image styling
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

    // Optimistically update the UI
    setTasks((prev) =>
      prev.map((t) =>
        t.id === draggedTask.id ? { ...t, status: newStatus } : t
      )
    );

    // Update on server
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${draggedTask.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: newStatus }),
        }
      );

      if (!response.ok) {
        // Revert on failure
        fetchTasks();
      }
    } catch {
      // Revert on failure
      fetchTasks();
    }
  }

  // Group tasks by status
  const tasksByStatus = KANBAN_COLUMNS.reduce(
    (acc, status) => {
      acc[status] = tasks.filter((t) => t.status === status);
      return acc;
    },
    {} as Record<TaskStatus, Task[]>
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
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      <TaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        task={selectedTask}
        orgId={orgId}
        projectId={projectId}
        onSuccess={handleSuccess}
        pmEnabled={true}
        defaultStatus={defaultStatus}
        currentUserId={currentUserId}
      />
    </>
  );
}

function KanbanCard({
  task,
  onClick,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
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
