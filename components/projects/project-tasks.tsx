"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Plus,
  Loader2,
  DollarSign,
  Archive,
  Eye,
  EyeOff,
} from "lucide-react";
import { TaskDialog, type Task } from "./task-dialog";

type ProjectTasksProps = {
  orgId: string;
  projectId: string;
};

export function ProjectTasks({ orgId, projectId }: ProjectTasksProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Quick add state
  const [newTaskName, setNewTaskName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Edit dialog state
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const fetchTasks = useCallback(async () => {
    try {
      const url = `/api/v1/organizations/${orgId}/projects/${projectId}/tasks${
        showArchived ? "?includeArchived=true" : ""
      }`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error("Failed to fetch tasks");
      }

      const data = await response.json();
      setTasks(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId, showArchived]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskName.trim() || isCreating) return;

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newTaskName.trim() }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create task");
      }

      setNewTaskName("");
      fetchTasks();
      // Keep focus on input for rapid entry
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsCreating(false);
    }
  };

  const handleTaskClick = (task: Task) => {
    setEditingTask(task);
    setIsDialogOpen(true);
  };

  const handleDialogSuccess = () => {
    fetchTasks();
  };

  // Separate active and archived tasks
  const activeTasks = tasks.filter((t) => !t.isArchived);
  const archivedTasks = tasks.filter((t) => t.isArchived);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with show archived toggle */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">Tasks</h3>
        {archivedTasks.length > 0 && (
          <div className="flex items-center gap-2">
            <Label
              htmlFor="show-archived"
              className="text-xs text-muted-foreground cursor-pointer"
            >
              {showArchived ? (
                <Eye className="size-3.5 inline mr-1" />
              ) : (
                <EyeOff className="size-3.5 inline mr-1" />
              )}
              {showArchived ? "Showing archived" : "Show archived"}
            </Label>
            <Switch
              id="show-archived"
              size="sm"
              checked={showArchived}
              onCheckedChange={setShowArchived}
            />
          </div>
        )}
      </div>

      {/* Task list */}
      {tasks.length === 0 && !isLoading ? (
        <div className="text-sm text-muted-foreground py-4 text-center">
          No tasks yet. Add one below.
        </div>
      ) : (
        <ul className="divide-y divide-border/50">
          {activeTasks.map((task) => (
            <TaskRow key={task.id} task={task} onClick={handleTaskClick} />
          ))}
          {showArchived &&
            archivedTasks.map((task) => (
              <TaskRow key={task.id} task={task} onClick={handleTaskClick} />
            ))}
        </ul>
      )}

      {/* Quick add form */}
      <form onSubmit={handleQuickAdd} className="flex gap-2">
        <div className="relative flex-1">
          <Input
            ref={inputRef}
            value={newTaskName}
            onChange={(e) => setNewTaskName(e.target.value)}
            placeholder="Add a task..."
            className="squircle h-9 text-sm"
            disabled={isCreating}
          />
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={!newTaskName.trim() || isCreating}
          className="squircle h-9"
        >
          {isCreating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          <span className="sr-only">Add task</span>
        </Button>
      </form>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* Edit dialog */}
      {editingTask && (
        <TaskDialog
          open={isDialogOpen}
          onOpenChange={setIsDialogOpen}
          task={editingTask}
          orgId={orgId}
          projectId={projectId}
          onSuccess={handleDialogSuccess}
        />
      )}
    </div>
  );
}

// Task row component - kept compact and subtle
function TaskRow({
  task,
  onClick,
}: {
  task: Task;
  onClick: (task: Task) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onClick(task)}
        className={`w-full flex items-center gap-3 py-2.5 px-1 text-left hover:bg-muted/50 transition-colors rounded-sm ${
          task.isArchived ? "opacity-60" : ""
        }`}
      >
        <span className="flex-1 text-sm truncate">{task.name}</span>

        <div className="flex items-center gap-2 text-muted-foreground">
          {/* Rate override indicator */}
          {task.rateOverride !== null && (
            <span className="flex items-center gap-0.5 text-xs">
              <DollarSign className="size-3" />
              {(task.rateOverride / 100).toFixed(0)}
            </span>
          )}

          {/* Billable indicator */}
          {task.isBillable === false && (
            <span className="text-xs bg-muted px-1.5 py-0.5 rounded">
              Non-billable
            </span>
          )}

          {/* Archived badge */}
          {task.isArchived && (
            <span className="flex items-center gap-0.5 text-xs bg-muted px-1.5 py-0.5 rounded">
              <Archive className="size-3" />
              Archived
            </span>
          )}
        </div>
      </button>
    </li>
  );
}
