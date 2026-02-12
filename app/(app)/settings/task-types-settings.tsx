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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  GripVertical,
  Pencil,
  Archive,
  ArchiveRestore,
  Plus,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

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

type TaskType = {
  id: string;
  name: string;
  color: string | null;
  position: number;
  isArchived: boolean | null;
  createdAt: string;
};

// --- Sortable row ---

function SortableTypeRow({
  type,
  onEdit,
  onToggleArchive,
}: {
  type: TaskType;
  onEdit: (type: TaskType) => void;
  onToggleArchive: (type: TaskType) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: type.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isArchived = !!type.isArchived;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-3 rounded-md border px-3 py-2",
        isDragging && "z-10 shadow-md bg-background",
        isArchived && "opacity-50"
      )}
    >
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>

      <span
        className="size-3 shrink-0 rounded-full"
        style={{ backgroundColor: type.color || "#94a3b8" }}
      />

      <span
        className={cn(
          "flex-1 text-sm",
          isArchived && "line-through text-muted-foreground"
        )}
      >
        {type.name}
      </span>

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => onEdit(type)}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => onToggleArchive(type)}
        >
          {isArchived ? (
            <ArchiveRestore className="size-3.5" />
          ) : (
            <Archive className="size-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

// --- Add/Edit dialog ---

function TypeDialog({
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
          <DialogTitle>{initial ? "Edit Type" : "Add Type"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="type-name">Name</Label>
            <Input
              id="type-name"
              className="squircle"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Bug, Feature, Design"
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

export function TaskTypesSettings({ orgId }: { orgId: string }) {
  const [types, setTypes] = useState<TaskType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingType, setEditingType] = useState<TaskType | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const fetchTypes = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/task-types`
      );
      if (res.ok) {
        const data = await res.json();
        setTypes(data);
      }
    } catch (err) {
      console.error("Error fetching task types:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchTypes();
  }, [fetchTypes]);

  // Derived lists
  const activeTypes = types.filter((t) => !t.isArchived);
  const archivedTypes = types.filter((t) => !!t.isArchived);
  const visibleTypes = showArchived ? types : activeTypes;

  // --- Handlers ---

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = visibleTypes.findIndex((t) => t.id === active.id);
    const newIndex = visibleTypes.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(visibleTypes, oldIndex, newIndex);

    // Build the full list with updated positions
    const updatedAll = showArchived
      ? reordered.map((t, i) => ({ ...t, position: i }))
      : [
          ...reordered.map((t, i) => ({ ...t, position: i })),
          ...archivedTypes,
        ];

    // Optimistic update
    setTypes(updatedAll);

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/task-types/reorder`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order: reordered.map((item, i) => ({
              id: item.id,
              position: i,
            })),
          }),
        }
      );
      if (!res.ok) {
        toast.error("Failed to reorder types");
        fetchTypes();
      }
    } catch {
      toast.error("Failed to reorder types");
      fetchTypes();
    }
  };

  const handleSave = async (data: { name: string; color: string | null }) => {
    if (editingType) {
      // Edit existing
      const res = await fetch(
        `/api/v1/organizations/${orgId}/task-types/${editingType.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      );
      if (!res.ok) {
        toast.error("Failed to update type");
        return;
      }
      const updated = await res.json();
      setTypes((prev) =>
        prev.map((t) => (t.id === updated.id ? updated : t))
      );
      toast.success("Type updated");
    } else {
      // Create new
      const res = await fetch(
        `/api/v1/organizations/${orgId}/task-types`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...data,
            position: types.length,
          }),
        }
      );
      if (!res.ok) {
        toast.error("Failed to create type");
        return;
      }
      const created = await res.json();
      setTypes((prev) => [...prev, created]);
      toast.success("Type created");
    }
  };

  const handleToggleArchive = async (type: TaskType) => {
    const newArchived = !type.isArchived;

    // Optimistic update
    setTypes((prev) =>
      prev.map((t) =>
        t.id === type.id ? { ...t, isArchived: newArchived } : t
      )
    );

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/task-types/${type.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isArchived: newArchived }),
        }
      );
      if (!res.ok) {
        // Revert
        setTypes((prev) =>
          prev.map((t) =>
            t.id === type.id ? { ...t, isArchived: type.isArchived } : t
          )
        );
        toast.error("Failed to update type");
      } else {
        toast.success(newArchived ? "Type archived" : "Type restored");
      }
    } catch {
      setTypes((prev) =>
        prev.map((t) =>
          t.id === type.id ? { ...t, isArchived: type.isArchived } : t
        )
      );
      toast.error("Failed to update type");
    }
  };

  const openAddDialog = () => {
    setEditingType(null);
    setDialogOpen(true);
  };

  const openEditDialog = (type: TaskType) => {
    setEditingType(type);
    setDialogOpen(true);
  };

  // --- Render ---

  if (isLoading) {
    return (
      <Card className="max-w-2xl squircle" id="task-types">
        <CardHeader>
          <CardTitle>Task Types</CardTitle>
          <CardDescription>Categorize tasks by type.</CardDescription>
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
      <Card className="max-w-2xl squircle" id="task-types">
        <CardHeader>
          <CardTitle>Task Types</CardTitle>
          <CardDescription>Categorize tasks by type.</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={openAddDialog}>
              <Plus className="size-4 mr-1.5" />
              Add Type
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {types.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No task types yet. Add types to categorize tasks.
            </p>
          ) : (
            <>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={visibleTypes.map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1.5">
                    {visibleTypes.map((type) => (
                      <SortableTypeRow
                        key={type.id}
                        type={type}
                        onEdit={openEditDialog}
                        onToggleArchive={handleToggleArchive}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              {archivedTypes.length > 0 && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowArchived(!showArchived)}
                >
                  {showArchived
                    ? "Hide archived"
                    : `Show archived (${archivedTypes.length})`}
                </button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <TypeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={
          editingType
            ? { name: editingType.name, color: editingType.color }
            : null
        }
        onSave={handleSave}
      />
    </>
  );
}
