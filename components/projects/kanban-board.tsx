"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Plus, GripVertical, Edit, Archive, User } from "lucide-react";
import {
  TaskDialog,
  type Task,
  type TaskStatus,
  TASK_STATUS_LABELS,
  TASK_STATUS_COLORS,
} from "./task-dialog";
import { cn } from "@/lib/utils";

const KANBAN_COLUMNS: TaskStatus[] = ["todo", "in_progress", "review", "done"];

type KanbanBoardProps = {
  orgId: string;
  projectId: string;
};

export function KanbanBoard({ orgId, projectId }: KanbanBoardProps) {
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
      <div className="grid grid-cols-4 gap-4 min-h-[400px]">
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
                  <KanbanCard
                    key={task.id}
                    task={task}
                    onEdit={() => handleEditTask(task)}
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
      />
    </>
  );
}

function KanbanCard({
  task,
  onEdit,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  onEdit: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
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
            <span className="font-medium text-sm leading-tight">
              {task.name}
            </span>
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

      {/* Footer with metadata */}
      <div className="flex items-center gap-2 mt-auto">
        {task.isArchived && (
          <Archive className="size-3 text-amber-600 dark:text-amber-400" />
        )}
        {task.assignedTo && (
          <div className="flex items-center justify-center size-5 rounded-full bg-muted">
            <User className="size-3 text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  );
}
