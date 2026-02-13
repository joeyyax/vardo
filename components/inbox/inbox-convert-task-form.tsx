"use client";

import { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProjectSelector } from "@/components/expenses/project-selector";
import { TaskSelector } from "@/components/timeline/task-selector";
import { toast } from "sonner";
import type { InboxItem } from "./types";

type InboxConvertTaskFormProps = {
  orgId: string;
  item: InboxItem;
  onConverted: () => void;
  onCancel: () => void;
};

export function InboxConvertTaskForm({
  orgId,
  item,
  onConverted,
  onCancel,
}: InboxConvertTaskFormProps) {
  const [mode, setMode] = useState<"new" | "attach">("new");
  const [name, setName] = useState(item.subject || "");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string | null>(item.projectId);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const [taskSelectorOpen, setTaskSelectorOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (mode === "new" && !name.trim()) {
      toast.error("Task name is required");
      return;
    }

    if (mode === "attach" && !taskId) {
      toast.error("Select a task to attach to");
      return;
    }

    setSubmitting(true);
    try {
      const body =
        mode === "new"
          ? {
              mode: "new" as const,
              name: name.trim(),
              description: description.trim() || null,
              projectId,
            }
          : {
              mode: "attach" as const,
              taskId,
              content: item.subject
                ? `Attached from email: ${item.subject}`
                : null,
            };

      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox/${item.id}/convert-task`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to convert");
      }

      onConverted();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create task"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-medium">Convert to Task</h3>

      <div className="grid gap-3">
        <div className="space-y-1.5">
          <Label>Mode</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as "new" | "attach")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">Create new task</SelectItem>
              <SelectItem value="attach">Attach to existing task</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {mode === "new" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="convert-task-name">Task Name</Label>
              <Input
                id="convert-task-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Task name"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="convert-task-description">Description</Label>
              <Textarea
                id="convert-task-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Optional description"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Project</Label>
              <ProjectSelector
                orgId={orgId}
                selectedProjectId={projectId}
                onSelect={setProjectId}
                open={projectSelectorOpen}
                onOpenChange={setProjectSelectorOpen}
              >
                <Button
                  variant="outline"
                  role="combobox"
                  className="w-full justify-between font-normal"
                  type="button"
                >
                  {projectId
                    ? item.project?.id === projectId
                      ? item.project.name
                      : "Project selected"
                    : "Select a project"}
                  <ChevronDown className="ml-2 size-4 opacity-50" />
                </Button>
              </ProjectSelector>
            </div>
          </>
        ) : (
          <div className="space-y-1.5">
            <Label>Task</Label>
            <TaskSelector
              orgId={orgId}
              selectedTaskId={taskId}
              onSelect={(id) => {
                setTaskId(id);
                setTaskSelectorOpen(false);
              }}
              open={taskSelectorOpen}
              onOpenChange={setTaskSelectorOpen}
            >
              <Button
                variant="outline"
                role="combobox"
                className="w-full justify-between font-normal"
                type="button"
              >
                {taskId ? "Task selected" : "Select a task"}
                <ChevronDown className="ml-2 size-4 opacity-50" />
              </Button>
            </TaskSelector>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
          {mode === "new" ? "Create Task" : "Attach to Task"}
        </Button>
      </div>
    </form>
  );
}
