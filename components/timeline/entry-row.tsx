"use client";

import { useState, useRef, useEffect, KeyboardEvent, DragEvent } from "react";
import { Copy, Trash2, DollarSign, GripVertical, Repeat } from "lucide-react";
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
import { HierarchySelector } from "./hierarchy-selector";

interface EntryRowProps {
  entry: TimeEntry;
  orgId: string;
  onUpdate: (
    entryId: string,
    updates: Partial<{
      description: string | null;
      clientId: string;
      projectId: string | null;
      taskId: string | null;
      durationMinutes: number;
      isBillableOverride: boolean | null;
    }>
  ) => Promise<void>;
  onDelete: (entryId: string) => Promise<void>;
  onDuplicate: (entry: TimeEntry) => Promise<void>;
  onMakeRecurring?: (entry: TimeEntry) => void;
  isHighlighted?: boolean;
  onClearHighlight?: () => void;
}

type EditingField = "description" | "duration" | null;

/**
 * Render hierarchy chips for an entry.
 * Shows: [Project] [Task] [Client] as styled chips
 * Falls back to just [Client] if no project.
 */
function HierarchyChips({ entry }: { entry: TimeEntry }) {
  const chipClass = "inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-muted/60 text-muted-foreground";
  const emptyChipClass = "inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-muted/30 text-muted-foreground/50";

  if (entry.project) {
    return (
      <span className="flex items-center gap-1">
        <span className={chipClass}>{entry.project.name}</span>
        {entry.task ? (
          <span className={chipClass}>{entry.task.name}</span>
        ) : (
          <span className={emptyChipClass}>—</span>
        )}
        <span className={chipClass}>{entry.client.name}</span>
      </span>
    );
  }
  return <span className={chipClass}>{entry.client.name}</span>;
}

export function EntryRow({
  entry,
  orgId,
  onUpdate,
  onDelete,
  onDuplicate,
  onMakeRecurring,
  isHighlighted,
  onClearHighlight,
}: EntryRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [editValue, setEditValue] = useState("");
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  // Scroll into view and clear highlight after a delay
  useEffect(() => {
    if (isHighlighted && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      const timer = setTimeout(() => {
        onClearHighlight?.();
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isHighlighted, onClearHighlight]);

  // Drag handlers
  const handleDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", entry.id);
    e.dataTransfer.setData("application/x-entry-date", entry.date);
    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

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

  const handleHierarchySelect = async (selection: {
    clientId: string;
    projectId: string | null;
    taskId: string | null;
  }) => {
    // Check if hierarchy actually changed
    const changed =
      selection.clientId !== entry.client.id ||
      selection.projectId !== (entry.project?.id || null) ||
      selection.taskId !== (entry.task?.id || null);

    if (changed) {
      await onUpdate(entry.id, {
        clientId: selection.clientId,
        projectId: selection.projectId,
        taskId: selection.taskId,
      });
    }
    setIsSelectorOpen(false);
  };

  const clientColor = entry.client.color || "#6b7280";

  return (
    <>
      <div
        ref={rowRef}
        className={cn(
          "group flex items-center gap-4 py-2 px-3 -mx-3 rounded-lg transition-colors",
          isHovered && "bg-muted/50",
          isDragging && "opacity-50",
          isHighlighted && "ring-2 ring-primary ring-offset-2 bg-primary/5"
        )}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Drag handle */}
        <div
          className={cn(
            "cursor-grab active:cursor-grabbing transition-opacity text-muted-foreground/40 hover:text-muted-foreground",
            isHovered ? "opacity-100" : "opacity-0"
          )}
        >
          <GripVertical className="size-4" />
        </div>

        {/* Client color dot */}
        <div
          className="size-2 rounded-full shrink-0"
          style={{ backgroundColor: clientColor }}
        />

        {/* Description + Tags */}
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
            <div className="flex items-center gap-2 min-w-0">
              <button
                onClick={() => startEditing("description")}
                className="text-left text-sm truncate hover:text-primary transition-colors"
              >
                {entry.description || (
                  <span className="text-muted-foreground italic">
                    No description
                  </span>
                )}
              </button>
              {entry.tags.length > 0 && (
                <div className="flex items-center gap-1 shrink-0">
                  {entry.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary/80"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Hierarchy selector (Client/Project/Task) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <HierarchySelector
                orgId={orgId}
                selectedClientId={entry.client.id}
                selectedProjectId={entry.project?.id || null}
                selectedTaskId={entry.task?.id || null}
                onSelect={handleHierarchySelect}
                open={isSelectorOpen}
                onOpenChange={setIsSelectorOpen}
              >
                <button
                  onClick={() => setIsSelectorOpen(true)}
                  className="text-sm hover:opacity-80 transition-opacity"
                >
                  <HierarchyChips entry={entry} />
                </button>
              </HierarchySelector>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" align="start" className="max-w-xs">
            <div className="space-y-1">
              {entry.project ? (
                <>
                  <div className="flex items-center gap-2">
                    <div
                      className="size-2 rounded-full shrink-0"
                      style={{ backgroundColor: entry.client.color || "#94a3b8" }}
                    />
                    <span className="font-medium">{entry.project.name}</span>
                    {entry.project.code && (
                      <span className="ml-2 font-mono text-xs bg-muted px-1 rounded">
                        {entry.project.code}
                      </span>
                    )}
                  </div>
                  {entry.task && (
                    <div className="pl-4 text-muted-foreground text-xs">
                      {entry.task.name}
                    </div>
                  )}
                  <div className="pl-4 text-muted-foreground text-xs">
                    {entry.client.name}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <div
                    className="size-2 rounded-full shrink-0"
                    style={{ backgroundColor: entry.client.color || "#94a3b8" }}
                  />
                  <span className="font-medium">{entry.client.name}</span>
                </div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>

        {/* Recurring indicator */}
        {entry.recurringTemplateId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onMakeRecurring?.(entry)}
                className="size-6 flex items-center justify-center rounded transition-colors text-primary/60 hover:text-primary"
              >
                <Repeat className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Recurring entry (click to edit)</TooltipContent>
          </Tooltip>
        )}

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

          {onMakeRecurring && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onMakeRecurring(entry)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Repeat className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Make recurring</TooltipContent>
            </Tooltip>
          )}

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
