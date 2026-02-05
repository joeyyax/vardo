"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Plus,
  ListTodo,
  Filter,
  Edit,
  Archive,
  User,
  RefreshCw,
} from "lucide-react";
import {
  TaskDialog,
  type Task,
  type TaskStatus,
  TASK_STATUS_LABELS,
  TASK_STATUS_COLORS,
} from "./task-dialog";

type TaskListProps = {
  orgId: string;
  projectId: string;
  pmEnabled?: boolean;
};

export function TaskList({ orgId, projectId, pmEnabled = false }: TaskListProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all" | "category">("all");
  const [showArchived, setShowArchived] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [defaultStatus, setDefaultStatus] = useState<TaskStatus | null>(null);

  const fetchTasks = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (showArchived) {
        params.set("includeArchived", "true");
      }
      if (statusFilter !== "all") {
        params.set("status", statusFilter);
      }

      const url = `/api/v1/organizations/${orgId}/projects/${projectId}/tasks${
        params.toString() ? `?${params.toString()}` : ""
      }`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error("Failed to fetch tasks");
      }

      const data = await response.json();
      setTasks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId, statusFilter, showArchived]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  function handleNewTask(status?: TaskStatus | null) {
    setSelectedTask(null);
    setDefaultStatus(status ?? null);
    setDialogOpen(true);
  }

  function handleEditTask(task: Task) {
    setSelectedTask(task);
    setDialogOpen(true);
  }

  function handleSuccess() {
    fetchTasks();
  }

  // Group tasks by status for display
  const groupedTasks = pmEnabled
    ? {
        category: tasks.filter((t) => !t.status),
        todo: tasks.filter((t) => t.status === "todo"),
        in_progress: tasks.filter((t) => t.status === "in_progress"),
        review: tasks.filter((t) => t.status === "review"),
        done: tasks.filter((t) => t.status === "done"),
      }
    : null;

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-lg border bg-muted/50"
          />
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
      <div className="space-y-4">
        {/* Header with filters */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {pmEnabled && (
              <div className="flex items-center gap-2">
                <Filter className="size-4 text-muted-foreground" />
                <Select
                  value={statusFilter}
                  onValueChange={(value) =>
                    setStatusFilter(value as TaskStatus | "all" | "category")
                  }
                >
                  <SelectTrigger className="squircle w-[150px]">
                    <SelectValue placeholder="All tasks" />
                  </SelectTrigger>
                  <SelectContent className="squircle">
                    <SelectItem value="all">All tasks</SelectItem>
                    <SelectItem value="category">Categories</SelectItem>
                    {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map(
                      (status) => (
                        <SelectItem key={status} value={status}>
                          <div className="flex items-center gap-2">
                            <div
                              className={`size-2 rounded-full ${
                                TASK_STATUS_COLORS[status].split(" ")[0]
                              }`}
                            />
                            {TASK_STATUS_LABELS[status]}
                          </div>
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Switch
                id="show-archived-tasks"
                checked={showArchived}
                onCheckedChange={setShowArchived}
                size="sm"
              />
              <Label
                htmlFor="show-archived-tasks"
                className="cursor-pointer text-sm text-muted-foreground"
              >
                Show archived
              </Label>
            </div>
          </div>

          <Button onClick={() => handleNewTask()} className="squircle">
            <Plus className="size-4" />
            New task
          </Button>
        </div>

        {/* Task list */}
        {tasks.length === 0 ? (
          <EmptyState onNewTask={handleNewTask} pmEnabled={pmEnabled} />
        ) : pmEnabled && groupedTasks && statusFilter === "all" ? (
          // Grouped view when PM is enabled and showing all
          <div className="space-y-6">
            {groupedTasks.category.length > 0 && (
              <TaskGroup
                title="Categories"
                tasks={groupedTasks.category}
                onEdit={handleEditTask}
                pmEnabled={pmEnabled}
              />
            )}
            {groupedTasks.todo.length > 0 && (
              <TaskGroup
                title="To Do"
                status="todo"
                tasks={groupedTasks.todo}
                onEdit={handleEditTask}
                onNewTask={() => handleNewTask("todo")}
                pmEnabled={pmEnabled}
              />
            )}
            {groupedTasks.in_progress.length > 0 && (
              <TaskGroup
                title="In Progress"
                status="in_progress"
                tasks={groupedTasks.in_progress}
                onEdit={handleEditTask}
                onNewTask={() => handleNewTask("in_progress")}
                pmEnabled={pmEnabled}
              />
            )}
            {groupedTasks.review.length > 0 && (
              <TaskGroup
                title="Review"
                status="review"
                tasks={groupedTasks.review}
                onEdit={handleEditTask}
                onNewTask={() => handleNewTask("review")}
                pmEnabled={pmEnabled}
              />
            )}
            {groupedTasks.done.length > 0 && (
              <TaskGroup
                title="Done"
                status="done"
                tasks={groupedTasks.done}
                onEdit={handleEditTask}
                onNewTask={() => handleNewTask("done")}
                pmEnabled={pmEnabled}
              />
            )}
          </div>
        ) : (
          // Flat list view
          <div className="space-y-2">
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onEdit={() => handleEditTask(task)}
                pmEnabled={pmEnabled}
              />
            ))}
          </div>
        )}
      </div>

      <TaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        task={selectedTask}
        orgId={orgId}
        projectId={projectId}
        onSuccess={handleSuccess}
        pmEnabled={pmEnabled}
        defaultStatus={defaultStatus}
      />
    </>
  );
}

function TaskGroup({
  title,
  status,
  tasks,
  onEdit,
  onNewTask,
  pmEnabled,
}: {
  title: string;
  status?: TaskStatus;
  tasks: Task[];
  onEdit: (task: Task) => void;
  onNewTask?: () => void;
  pmEnabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {status && (
            <div
              className={`size-2.5 rounded-full ${
                TASK_STATUS_COLORS[status].split(" ")[0]
              }`}
            />
          )}
          <h3 className="text-sm font-medium text-muted-foreground">
            {title}
          </h3>
          <span className="text-xs text-muted-foreground/60">
            ({tasks.length})
          </span>
        </div>
        {onNewTask && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onNewTask}
            className="h-7 px-2"
          >
            <Plus className="size-3" />
          </Button>
        )}
      </div>
      <div className="space-y-2">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onEdit={() => onEdit(task)}
            pmEnabled={pmEnabled}
            showStatus={false}
          />
        ))}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  onEdit,
  pmEnabled,
  showStatus = true,
}: {
  task: Task;
  onEdit: () => void;
  pmEnabled: boolean;
  showStatus?: boolean;
}) {
  return (
    <div
      className="squircle flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50 cursor-pointer"
      onClick={onEdit}
    >
      {/* Task info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{task.name}</span>
          {/* Status badge */}
          {pmEnabled && showStatus && task.status && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded ${TASK_STATUS_COLORS[task.status]}`}
            >
              {TASK_STATUS_LABELS[task.status]}
            </span>
          )}
          {/* Recurring indicator */}
          {task.isRecurring && (
            <RefreshCw className="size-3 text-muted-foreground" />
          )}
          {/* Archived indicator */}
          {task.isArchived && (
            <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <Archive className="size-3" />
            </span>
          )}
        </div>
        {/* Description preview */}
        {pmEnabled && task.description && (
          <p className="text-sm text-muted-foreground truncate mt-0.5">
            {task.description}
          </p>
        )}
      </div>

      {/* Assigned user indicator */}
      {pmEnabled && task.assignedTo && (
        <div className="flex items-center text-muted-foreground">
          <User className="size-4" />
        </div>
      )}

      {/* Edit button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        className="squircle shrink-0 size-8"
      >
        <Edit className="size-4" />
        <span className="sr-only">Edit {task.name}</span>
      </Button>
    </div>
  );
}

function EmptyState({
  onNewTask,
  pmEnabled,
}: {
  onNewTask: () => void;
  pmEnabled: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <ListTodo className="size-5 text-muted-foreground" />
      </div>
      <h3 className="mt-3 text-base font-medium">No tasks yet</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {pmEnabled
          ? "Create tasks to organize work and track progress on this project."
          : "Create task categories to organize time entries for this project."}
      </p>
      <Button onClick={onNewTask} className="mt-4 squircle">
        <Plus className="size-4" />
        Add your first task
      </Button>
    </div>
  );
}
