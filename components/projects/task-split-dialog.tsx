"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

type TaskEntry = {
  name: string;
  description: string;
};

type TaskSplitDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: {
    id: string;
    name: string;
    description: string | null;
  };
  orgId: string;
  projectId: string;
  onSuccess: () => void;
};

export function TaskSplitDialog({
  open,
  onOpenChange,
  task,
  orgId,
  projectId,
  onSuccess,
}: TaskSplitDialogProps) {
  const [entries, setEntries] = useState<TaskEntry[]>([
    { name: "", description: "" },
    { name: "", description: "" },
  ]);
  const [submitting, setSubmitting] = useState(false);

  const updateEntry = (index: number, field: keyof TaskEntry, value: string) => {
    setEntries((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const addEntry = () => {
    setEntries((prev) => [...prev, { name: "", description: "" }]);
  };

  const removeEntry = (index: number) => {
    if (entries.length <= 2) return;
    setEntries((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    const validTasks = entries.filter((e) => e.name.trim());
    if (validTasks.length < 2) {
      toast.error("At least 2 tasks with names are required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${task.id}/split`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tasks: validTasks.map((e) => ({
              name: e.name.trim(),
              description: e.description.trim() || undefined,
            })),
          }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to split task");
      }

      const data = await res.json();
      toast.success(`Split into ${data.tasks.length} tasks`);
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Split Bug Report into Tasks</DialogTitle>
          <DialogDescription>
            Break this bug report into separate, actionable tasks. The original
            task will be archived.
          </DialogDescription>
        </DialogHeader>

        {/* Original bug description for reference */}
        {task.description && (
          <div className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground max-h-24 overflow-y-auto">
            <div className="text-xs font-medium text-muted-foreground mb-1">Original report:</div>
            <p className="whitespace-pre-wrap">{task.description}</p>
          </div>
        )}

        {/* Task entries */}
        <div className="space-y-4 max-h-[40vh] overflow-y-auto">
          {entries.map((entry, i) => (
            <div key={i} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground shrink-0">
                  Task {i + 1}
                </span>
                {entries.length > 2 && (
                  <button
                    type="button"
                    onClick={() => removeEntry(i)}
                    className="ml-auto text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              <Input
                placeholder="Task name"
                value={entry.name}
                onChange={(e) => updateEntry(i, "name", e.target.value)}
                className="squircle"
              />
              <Textarea
                placeholder="Description (optional)"
                value={entry.description}
                onChange={(e) => updateEntry(i, "description", e.target.value)}
                rows={2}
                className="squircle text-sm"
              />
            </div>
          ))}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addEntry}
          className="squircle w-full"
        >
          <Plus className="size-4 mr-1" />
          Add Task
        </Button>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="squircle"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className="squircle"
          >
            {submitting ? "Splitting..." : "Split Tasks"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
