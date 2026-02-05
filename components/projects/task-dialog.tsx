"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Archive, ArchiveRestore } from "lucide-react";

export type TaskStatus = "todo" | "in_progress" | "review" | "done";

export type Task = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  isArchived: boolean;
  status: TaskStatus | null;
  isRecurring: boolean | null;
  assignedTo: string | null;
  createdBy: string | null;
  position: number | null;
  createdAt: string;
  updatedAt: string;
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

export const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  todo: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  review: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
};

type TaskDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task | null;
  orgId: string;
  projectId: string;
  onSuccess: () => void;
  pmEnabled?: boolean; // Show PM fields (status, description)
  defaultStatus?: TaskStatus | null; // Default status for new tasks
};

export function TaskDialog({
  open,
  onOpenChange,
  task,
  orgId,
  projectId,
  onSuccess,
  pmEnabled = false,
  defaultStatus = null,
}: TaskDialogProps) {
  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rateOverride, setRateOverride] = useState("");
  const [isBillable, setIsBillable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<TaskStatus | null>(null);

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = !!task;

  // Reset form when dialog opens or task changes
  useEffect(() => {
    if (open) {
      if (task) {
        setName(task.name);
        setDescription(task.description || "");
        // Convert cents to dollars for display
        setRateOverride(
          task.rateOverride !== null
            ? (task.rateOverride / 100).toString()
            : ""
        );
        setIsBillable(task.isBillable);
        setStatus(task.status);
      } else {
        // Creating new task - reset form
        setName("");
        setDescription("");
        setRateOverride("");
        setIsBillable(null);
        setStatus(defaultStatus);
      }
      setError(null);
    }
  }, [open, task, defaultStatus]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const payload = {
        name,
        description: description || null,
        rateOverride: rateOverride !== "" ? parseFloat(rateOverride) : null,
        isBillable,
        status,
      };

      const url = isEditing
        ? `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${task!.id}`
        : `/api/v1/organizations/${orgId}/projects/${projectId}/tasks`;

      const response = await fetch(url, {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  };

  const handleArchiveToggle = async () => {
    if (!task) return;
    setIsArchiving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${task.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isArchived: !task.isArchived }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsArchiving(false);
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${task.id}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsDeleting(false);
    }
  };

  const isDisabled = isLoading || isArchiving || isDeleting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit task" : "New task"}</DialogTitle>
            <DialogDescription>
              {isEditing
                ? "Update task details or manage its status."
                : "Create a new task for this project."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 py-6">
            {/* Name */}
            <div className="grid gap-2">
              <Label htmlFor="task-name">Name</Label>
              <Input
                id="task-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Task name"
                required
                autoFocus
                className="squircle"
              />
            </div>

            {/* Description - only show when PM is enabled */}
            {pmEnabled && (
              <div className="grid gap-2">
                <Label htmlFor="task-description">Description</Label>
                <Textarea
                  id="task-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Add details or notes..."
                  rows={3}
                  className="squircle resize-none"
                />
              </div>
            )}

            {/* Status - only show when PM is enabled */}
            {pmEnabled && (
              <div className="grid gap-2">
                <Label htmlFor="task-status">Status</Label>
                <Select
                  value={status || "category"}
                  onValueChange={(value) =>
                    setStatus(value === "category" ? null : (value as TaskStatus))
                  }
                >
                  <SelectTrigger id="task-status" className="squircle">
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent className="squircle">
                    <SelectItem value="category">
                      <span className="text-muted-foreground">Category only</span>
                    </SelectItem>
                    {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map(
                      (statusKey) => (
                        <SelectItem key={statusKey} value={statusKey}>
                          <div className="flex items-center gap-2">
                            <div
                              className={`size-2 rounded-full ${
                                TASK_STATUS_COLORS[statusKey].split(" ")[0]
                              }`}
                            />
                            {TASK_STATUS_LABELS[statusKey]}
                          </div>
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Category-only tasks appear in time entry dropdowns but not on the board.
                </p>
              </div>
            )}

            {/* Hourly rate override */}
            <div className="grid gap-2">
              <Label htmlFor="task-rate">Hourly rate override</Label>
              <p className="text-sm text-muted-foreground">
                Leave blank to inherit from project or client.
              </p>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  id="task-rate"
                  type="number"
                  min="0"
                  step="0.01"
                  value={rateOverride}
                  onChange={(e) => setRateOverride(e.target.value)}
                  placeholder="0.00"
                  className="squircle pl-7"
                />
              </div>
            </div>

            {/* Billable toggle */}
            <div className="flex items-center justify-between gap-4">
              <div className="grid gap-1">
                <Label htmlFor="task-billable">Billable</Label>
                <p className="text-sm text-muted-foreground">
                  {isBillable === null
                    ? "Inherits from project settings."
                    : isBillable
                    ? "Time tracked is billable."
                    : "Time tracked is not billable."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsBillable(null)}
                  className={`text-xs px-2 py-1 rounded transition-colors ${
                    isBillable === null
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Inherit
                </button>
                <Switch
                  id="task-billable"
                  checked={isBillable === true}
                  onCheckedChange={(checked) => setIsBillable(checked)}
                />
              </div>
            </div>

            {/* Archived status indicator */}
            {task?.isArchived && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-md">
                <Archive className="size-4" />
                <span>This task is archived.</span>
              </div>
            )}

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            {isEditing && (
              <div className="flex gap-2 mr-auto">
                {/* Archive/Unarchive button */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleArchiveToggle}
                  disabled={isDisabled}
                  className="squircle"
                >
                  {isArchiving && <Loader2 className="size-4 animate-spin" />}
                  {task?.isArchived ? (
                    <>
                      <ArchiveRestore className="size-4" />
                      Unarchive
                    </>
                  ) : (
                    <>
                      <Archive className="size-4" />
                      Archive
                    </>
                  )}
                </Button>

                {/* Delete button */}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={isDisabled}
                      className="squircle"
                    >
                      {isDeleting && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="squircle">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete task?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete &quot;{task?.name}&quot; and all
                      associated time entries. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="squircle">Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              </div>
            )}

            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isDisabled}
              className="squircle"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isDisabled || !name.trim()}
              className="squircle"
            >
              {isLoading && <Loader2 className="size-4 animate-spin" />}
              {isEditing ? "Save changes" : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
