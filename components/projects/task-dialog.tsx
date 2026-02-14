"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { DetailModal } from "@/components/ui/detail-modal";
import { IconButton } from "@/components/ui/icon-button";
import { Archive, ArchiveRestore, GitBranch, Pencil, Trash2 } from "lucide-react";
import { TaskRelationships } from "./task-relationships";
import { TaskComments } from "./task-comments";
import { TaskTags } from "./task-tags";
import { TaskDetailView } from "./task-detail-view";
import { TaskDetailEdit } from "./task-detail-edit";
import { TaskSplitDialog } from "./task-split-dialog";
import { WatchButton } from "@/components/watch-button";

export type TaskStatus = "todo" | "in_progress" | "review" | "done";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export type TaskType = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
};

export type TaskUser = {
  id: string;
  name: string | null;
  email: string;
};

export type TaskFile = {
  file: {
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  };
};

export type Task = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  isArchived: boolean;
  status: TaskStatus | null;
  priority: TaskPriority | null;
  isRecurring: boolean | null;
  assignedTo: string | null;
  createdBy: string | null;
  position: number | null;
  typeId: string | null;
  estimateMinutes: number | null;
  prLink: string | null;
  dueDate: string | null;
  isClientVisible: boolean;
  metadata: Record<string, unknown> | null;
  type?: TaskType | null;
  assignedToUser?: TaskUser | null;
  createdByUser?: TaskUser | null;
  files?: TaskFile[];
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
  in_progress:
    "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  review:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
};

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export const TASK_PRIORITY_COLORS: Record<TaskPriority, string> = {
  low: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  medium: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  urgent: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

type TaskDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task | null;
  orgId: string;
  projectId: string;
  onSuccess: () => void;
  pmEnabled?: boolean;
  defaultStatus?: TaskStatus | null;
  currentUserId?: string;
};

export function TaskDialog({
  open,
  onOpenChange,
  task: taskProp,
  orgId,
  projectId,
  onSuccess,
  pmEnabled = false,
  defaultStatus = null,
  currentUserId,
}: TaskDialogProps) {
  const [fullTask, setFullTask] = useState<Task | null>(null);
  const [isEditing, setIsEditing] = useState(!taskProp);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showSplitDialog, setShowSplitDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch full task details (with files, assignedToUser, createdByUser)
  const fetchFullTask = useCallback(async (taskId: string) => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}`
      );
      if (res.ok) {
        const data = await res.json();
        setFullTask(data);
      }
    } catch (err) {
      console.error("Error fetching task details:", err);
    }
  }, [orgId, projectId]);

  // Use full task when available, fall back to prop
  const task = fullTask?.id === taskProp?.id ? fullTask : taskProp;

  // Reset edit mode when dialog opens, fetch full task
  useEffect(() => {
    if (open) {
      setIsEditing(!taskProp);
      setError(null);
      if (taskProp?.id) {
        fetchFullTask(taskProp.id);
      } else {
        setFullTask(null);
      }
    }
  }, [open, taskProp, fetchFullTask]);

  const handleSave = useCallback(() => {
    setIsEditing(false);
    onSuccess();
    // Re-fetch full task to pick up any changes (e.g. new files, assignment)
    if (task?.id) {
      fetchFullTask(task.id);
    }
  }, [onSuccess, task?.id, fetchFullTask]);

  const handleCancel = useCallback(() => {
    if (task) {
      setIsEditing(false);
    } else {
      onOpenChange(false);
    }
  }, [task, onOpenChange]);

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
      setShowDeleteDialog(false);
    }
  };

  function getTitle(): string {
    if (!task) return "New task";
    if (isEditing) return "Edit task";
    return "Task Details";
  }

  function getDescription(): string {
    if (!task) return "Create a new task for this project.";
    if (isEditing) return "Update task details or manage its status.";
    return "View task details and discussion.";
  }

  const actions = isEditing ? (
    <>
      <Button
        variant="outline"
        onClick={handleCancel}
        size="sm"
        className="squircle"
      >
        Cancel
      </Button>
      <Button
        type="submit"
        form="task-edit-form"
        size="sm"
        className="squircle"
      >
        {task ? "Save" : "Create"}
      </Button>
    </>
  ) : (
    <>
      {task && (
        <>
          <WatchButton entityType="task" entityId={task.id} orgId={orgId} projectId={projectId} />
          {(task.metadata?.source === "widget" || task.metadata?.bugReportId) && !task.metadata?.split && (
            <IconButton
              icon={GitBranch}
              tooltip="Split into tasks"
              onClick={() => setShowSplitDialog(true)}
            />
          )}
          <IconButton
            icon={task.isArchived ? ArchiveRestore : Archive}
            tooltip={task.isArchived ? "Unarchive" : "Archive"}
            onClick={handleArchiveToggle}
            loading={isArchiving}
          />
          <IconButton
            icon={Trash2}
            tooltip="Delete"
            onClick={() => setShowDeleteDialog(true)}
            loading={isDeleting}
          />
        </>
      )}
      <IconButton
        icon={Pencil}
        tooltip="Edit"
        onClick={() => setIsEditing(true)}
      />
    </>
  );

  const sidebar =
    pmEnabled && task && currentUserId ? (
      <TaskComments
        orgId={orgId}
        projectId={projectId}
        taskId={task.id}
        currentUserId={currentUserId}
        onUpdate={onSuccess}
      />
    ) : undefined;

  return (
    <>
      <DetailModal
        open={open}
        onOpenChange={onOpenChange}
        title={getTitle()}
        description={getDescription()}
        actions={actions}
        sidebar={sidebar}
      >
        {task && !isEditing ? (
          <TaskDetailView task={task} orgId={orgId} projectId={projectId} onEdit={() => setIsEditing(true)} />
        ) : (
          <>
            <TaskDetailEdit
              task={task}
              orgId={orgId}
              projectId={projectId}
              pmEnabled={pmEnabled}
              defaultStatus={defaultStatus}
              onSave={handleSave}
              onCancel={handleCancel}
            />

            {pmEnabled && task && (
              <>
                <div className="border-t pt-6 mt-6">
                  <h4 className="text-sm font-medium mb-3">Relationships</h4>
                  <TaskRelationships
                    orgId={orgId}
                    projectId={projectId}
                    taskId={task.id}
                    onUpdate={onSuccess}
                  />
                </div>

                <div className="border-t pt-6 mt-6">
                  <h4 className="text-sm font-medium mb-3">Tags</h4>
                  <TaskTags
                    orgId={orgId}
                    projectId={projectId}
                    taskId={task.id}
                    onUpdate={onSuccess}
                  />
                </div>
              </>
            )}
          </>
        )}
      </DetailModal>

      {task && (
        <>
          <ConfirmDeleteDialog
            open={showDeleteDialog}
            onOpenChange={setShowDeleteDialog}
            title="Delete task?"
            description={`This will permanently delete "${task.name}" and all associated time entries. This action cannot be undone.`}
            onConfirm={handleDelete}
            loading={isDeleting}
          />
          {(task.metadata?.source === "widget" || task.metadata?.bugReportId) && !task.metadata?.split && (
            <TaskSplitDialog
              open={showSplitDialog}
              onOpenChange={setShowSplitDialog}
              task={task}
              orgId={orgId}
              projectId={projectId}
              onSuccess={() => {
                onSuccess();
                onOpenChange(false);
              }}
            />
          )}
        </>
      )}
    </>
  );
}
