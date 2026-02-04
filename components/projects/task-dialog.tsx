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
import { Loader2, Archive, ArchiveRestore } from "lucide-react";

export type Task = {
  id: string;
  projectId: string;
  name: string;
  rateOverride: number | null;
  isBillable: boolean | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
};

type TaskDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task;
  orgId: string;
  projectId: string;
  onSuccess: () => void;
};

export function TaskDialog({
  open,
  onOpenChange,
  task,
  orgId,
  projectId,
  onSuccess,
}: TaskDialogProps) {
  // Form state
  const [name, setName] = useState("");
  const [rateOverride, setRateOverride] = useState("");
  const [isBillable, setIsBillable] = useState<boolean | null>(null);

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens or task changes
  useEffect(() => {
    if (open && task) {
      setName(task.name);
      // Convert cents to dollars for display
      setRateOverride(
        task.rateOverride !== null
          ? (task.rateOverride / 100).toString()
          : ""
      );
      setIsBillable(task.isBillable);
      setError(null);
    }
  }, [open, task]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const payload = {
        name,
        rateOverride: rateOverride !== "" ? parseFloat(rateOverride) : null,
        isBillable,
      };

      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${task.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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
      setIsLoading(false);
    }
  };

  const handleArchiveToggle = async () => {
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
            <DialogTitle>Edit task</DialogTitle>
            <DialogDescription>
              Update task details or manage its status.
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
            {task.isArchived && (
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
                {task.isArchived ? (
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
                      This will permanently delete &quot;{task.name}&quot; and all
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
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
