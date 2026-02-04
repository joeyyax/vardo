"use client";

import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { Copy, Trash2, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TimeEntry } from "./types";
import { formatDuration, parseDuration } from "./utils";
import { TaskSelector } from "./task-selector";

interface EntryRowProps {
  entry: TimeEntry;
  orgId: string;
  onUpdate: (
    entryId: string,
    updates: Partial<{
      description: string | null;
      taskId: string;
      durationMinutes: number;
      isBillableOverride: boolean | null;
    }>
  ) => Promise<void>;
  onDelete: (entryId: string) => Promise<void>;
  onDuplicate: (entry: TimeEntry) => Promise<void>;
}

type EditingField = "description" | "duration" | null;

export function EntryRow({
  entry,
  orgId,
  onUpdate,
  onDelete,
  onDuplicate,
}: EntryRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [editValue, setEditValue] = useState("");
  const [isTaskSelectorOpen, setIsTaskSelectorOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (editingField && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingField]);

  const startEditing = (field: EditingField) => {
    if (field === "description") {
      setEditValue(entry.description || "");
    } else if (field === "duration") {
      setEditValue(formatDuration(entry.durationMinutes));
    }
    setEditingField(field);
  };

  const cancelEditing = () => {
    setEditingField(null);
    setEditValue("");
  };

  const saveEdit = async () => {
    if (!editingField || isSaving) return;

    setIsSaving(true);
    try {
      if (editingField === "description") {
        const newDescription = editValue.trim() || null;
        if (newDescription !== entry.description) {
          await onUpdate(entry.id, { description: newDescription });
        }
      } else if (editingField === "duration") {
        const newMinutes = parseDuration(editValue);
        if (newMinutes !== null && newMinutes > 0 && newMinutes !== entry.durationMinutes) {
          await onUpdate(entry.id, { durationMinutes: newMinutes });
        }
      }
    } finally {
      setIsSaving(false);
      setEditingField(null);
      setEditValue("");
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      cancelEditing();
    } else if (e.key === "Enter") {
      saveEdit();
    }
  };

  const toggleBillable = async () => {
    // If entry has an override, toggle it or clear it
    // If entry inherits billable status, set an explicit override
    const currentBillable = entry.isBillable;
    const hasOverride = entry.isBillableOverride !== null;

    let newOverride: boolean | null;
    if (hasOverride) {
      // If we have an override and it matches the inherited value, clear the override
      // Otherwise toggle the override
      newOverride = !currentBillable;
    } else {
      // No override - set explicit override to opposite of inherited
      newOverride = !currentBillable;
    }

    await onUpdate(entry.id, { isBillableOverride: newOverride });
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await onDelete(entry.id);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleDuplicate = () => {
    onDuplicate(entry);
  };

  const handleTaskSelect = async (taskId: string) => {
    if (taskId !== entry.task.id) {
      await onUpdate(entry.id, { taskId });
    }
    setIsTaskSelectorOpen(false);
  };

  const clientColor = entry.task.project.client.color || "#6b7280";

  return (
    <>
      <div
        className={cn(
          "group flex items-center gap-4 py-2 px-3 -mx-3 rounded-lg transition-colors",
          isHovered && "bg-muted/50"
        )}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Client color dot */}
        <div
          className="size-2 rounded-full shrink-0"
          style={{ backgroundColor: clientColor }}
        />

        {/* Description */}
        <div className="flex-1 min-w-0">
          {editingField === "description" ? (
            <Input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={saveEdit}
              onKeyDown={handleKeyDown}
              placeholder="What did you work on?"
              className="h-7 text-sm"
              disabled={isSaving}
            />
          ) : (
            <button
              onClick={() => startEditing("description")}
              className="text-left text-sm truncate block w-full hover:text-primary transition-colors"
            >
              {entry.description || (
                <span className="text-muted-foreground italic">
                  No description
                </span>
              )}
            </button>
          )}
        </div>

        {/* Project/Task selector */}
        <TaskSelector
          orgId={orgId}
          selectedTaskId={entry.task.id}
          onSelect={handleTaskSelect}
          open={isTaskSelectorOpen}
          onOpenChange={setIsTaskSelectorOpen}
        >
          <button
            onClick={() => setIsTaskSelectorOpen(true)}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors truncate max-w-[200px]"
          >
            {entry.task.project.client.name} / {entry.task.project.name}
            {entry.task.name !== "Default" && ` / ${entry.task.name}`}
          </button>
        </TaskSelector>

        {/* Billable indicator */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={toggleBillable}
              className={cn(
                "size-6 flex items-center justify-center rounded transition-colors",
                entry.isBillable
                  ? "text-green-600 hover:text-green-700"
                  : "text-muted-foreground/40 hover:text-muted-foreground"
              )}
            >
              <DollarSign className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {entry.isBillable ? "Billable" : "Non-billable"}
            {entry.isBillableOverride !== null && " (overridden)"}
          </TooltipContent>
        </Tooltip>

        {/* Duration */}
        <div className="w-14 text-right">
          {editingField === "duration" ? (
            <Input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={saveEdit}
              onKeyDown={handleKeyDown}
              placeholder="0:00"
              className="h-7 text-sm text-right w-14"
              disabled={isSaving}
            />
          ) : (
            <button
              onClick={() => startEditing("duration")}
              className="text-sm font-medium tabular-nums hover:text-primary transition-colors"
            >
              {formatDuration(entry.durationMinutes)}
            </button>
          )}
        </div>

        {/* Actions (visible on hover) */}
        <div
          className={cn(
            "flex items-center gap-1 transition-opacity",
            isHovered ? "opacity-100" : "opacity-0"
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleDuplicate}
                className="text-muted-foreground hover:text-foreground"
              >
                <Copy className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Duplicate entry</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setShowDeleteConfirm(true)}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete entry</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete entry?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this time entry. This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
