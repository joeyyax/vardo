"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardAction,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pencil, Trash2, Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const PRESET_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
  "#64748b",
];

type TaskTag = {
  id: string;
  name: string;
  color: string | null;
  isPredefined: boolean | null;
  createdAt: string;
};

// --- Tag row ---

function TagRow({
  tag,
  onEdit,
  onDelete,
}: {
  tag: TaskTag;
  onEdit: (tag: TaskTag) => void;
  onDelete: (tag: TaskTag) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <span
        className="size-3 shrink-0 rounded-full"
        style={{ backgroundColor: tag.color || "#94a3b8" }}
      />

      <span className="flex-1 text-sm">
        {tag.name}
        {tag.isPredefined === false && (
          <span className="ml-1.5 text-xs text-muted-foreground">(ad-hoc)</span>
        )}
      </span>

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => onEdit(tag)}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => onDelete(tag)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// --- Add/Edit dialog ---

function TagDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: { name: string; color: string | null } | null;
  onSave: (data: { name: string; color: string | null }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Sync fields when dialog opens or initial changes
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setColor(initial?.color ?? null);
    }
  }, [open, initial]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({ name: name.trim(), color });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit Tag" : "Add Tag"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="tag-name">Name</Label>
            <Input
              id="tag-name"
              className="squircle"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Urgent, Billable, Internal"
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) handleSave();
              }}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={cn(
                    "size-7 rounded-full border-2 transition-all",
                    color === c
                      ? "border-foreground scale-110"
                      : "border-transparent hover:border-muted-foreground/40"
                  )}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(color === c ? null : c)}
                />
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!name.trim() || saving}
          >
            {saving && <Loader2 className="size-4 animate-spin mr-2" />}
            {initial ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Main component ---

export function TaskTagsSettings({ orgId }: { orgId: string }) {
  const [tags, setTags] = useState<TaskTag[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<TaskTag | null>(null);

  // Delete confirmation state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingTag, setDeletingTag] = useState<TaskTag | null>(null);

  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/task-tags`
      );
      if (res.ok) {
        const data = await res.json();
        setTags(data);
      }
    } catch (err) {
      console.error("Error fetching task tags:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  // --- Handlers ---

  const handleSave = async (data: { name: string; color: string | null }) => {
    if (editingTag) {
      // Edit existing — if ad-hoc, promote to predefined
      const body: Record<string, unknown> = { ...data };
      if (editingTag.isPredefined === false) {
        body.isPredefined = true;
      }

      const res = await fetch(
        `/api/v1/organizations/${orgId}/task-tags/${editingTag.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        toast.error("Failed to update tag");
        return;
      }
      const updated = await res.json();
      setTags((prev) =>
        prev.map((t) => (t.id === updated.id ? updated : t))
      );
      toast.success("Tag updated");
    } else {
      // Create new
      const res = await fetch(
        `/api/v1/organizations/${orgId}/task-tags`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...data,
            isPredefined: true,
          }),
        }
      );
      if (!res.ok) {
        toast.error("Failed to create tag");
        return;
      }
      const created = await res.json();
      setTags((prev) => [...prev, created]);
      toast.success("Tag created");
    }
  };

  const handleDelete = async () => {
    if (!deletingTag) return;

    const tagToDelete = deletingTag;
    setDeleteDialogOpen(false);
    setDeletingTag(null);

    // Optimistic remove
    setTags((prev) => prev.filter((t) => t.id !== tagToDelete.id));

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/task-tags/${tagToDelete.id}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        // Revert
        setTags((prev) => [...prev, tagToDelete]);
        toast.error("Failed to delete tag");
      } else {
        toast.success("Tag deleted");
      }
    } catch {
      // Revert
      setTags((prev) => [...prev, tagToDelete]);
      toast.error("Failed to delete tag");
    }
  };

  const openAddDialog = () => {
    setEditingTag(null);
    setDialogOpen(true);
  };

  const openEditDialog = (tag: TaskTag) => {
    setEditingTag(tag);
    setDialogOpen(true);
  };

  const openDeleteDialog = (tag: TaskTag) => {
    setDeletingTag(tag);
    setDeleteDialogOpen(true);
  };

  // --- Render ---

  if (isLoading) {
    return (
      <Card className="max-w-2xl squircle" id="task-tags">
        <CardHeader>
          <CardTitle>Task Tags</CardTitle>
          <CardDescription>
            Label and filter tasks with tags.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="max-w-2xl squircle" id="task-tags">
        <CardHeader>
          <CardTitle>Task Tags</CardTitle>
          <CardDescription>
            Label and filter tasks with tags.
          </CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={openAddDialog}>
              <Plus className="size-4 mr-1.5" />
              Add Tag
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {tags.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No task tags yet. Add tags to label and filter tasks.
            </p>
          ) : (
            <div className="space-y-1.5">
              {tags.map((tag) => (
                <TagRow
                  key={tag.id}
                  tag={tag}
                  onEdit={openEditDialog}
                  onDelete={openDeleteDialog}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <TagDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={
          editingTag
            ? { name: editingTag.name, color: editingTag.color }
            : null
        }
        onSave={handleSave}
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete tag?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the tag from all tasks. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
