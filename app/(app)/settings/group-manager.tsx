"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Pencil, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";

type Project = {
  id: string;
  name: string;
  displayName: string;
  status: string;
};

type GroupWithProjects = {
  id: string;
  name: string;
  color: string;
  projects: Project[];
};

type Props = {
  groups: GroupWithProjects[];
  orgId: string;
};

const COLORS = [
  "#64748b", "#ef4444", "#f97316", "#f59e0b", "#22c55e",
  "#14b8a6", "#3b82f6", "#6366f1", "#a855f7", "#ec4899",
];

export function GroupManager({ groups: initialGroups, orgId }: Props) {
  const router = useRouter();
  const [groups, setGroups] = useState(initialGroups);
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("#6366f1");
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openEdit(group: GroupWithProjects) {
    setEditId(group.id);
    setEditName(group.name);
    setEditColor(group.color);
    setEditOpen(true);
  }

  async function handleSave() {
    if (!editName.trim() || !editId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/groups`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editId, name: editName.trim(), color: editColor }),
      });
      if (res.ok) {
        toast.success("Group updated");
        setEditOpen(false);
        setGroups((prev) =>
          prev.map((g) =>
            g.id === editId ? { ...g, name: editName.trim(), color: editColor } : g
          )
        );
        router.refresh();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to update group");
      }
    } catch {
      toast.error("Failed to update group");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/groups`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteId }),
      });
      if (res.ok) {
        toast.success("Group deleted");
        setGroups((prev) => prev.filter((g) => g.id !== deleteId));
        setDeleteId(null);
        router.refresh();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to delete group");
      }
    } catch {
      toast.error("Failed to delete group");
    } finally {
      setDeleting(false);
    }
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8">
        <p className="text-sm text-muted-foreground">
          No groups yet. Create one from a project&apos;s Edit panel.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {groups.map((group) => (
          <div
            key={group.id}
            className="squircle flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span
                className="size-3 rounded-full shrink-0"
                style={{ backgroundColor: group.color }}
              />
              <div className="min-w-0">
                <p className="text-sm font-medium">{group.name}</p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {group.projects.length === 0 ? (
                    <span className="text-xs text-muted-foreground">No projects</span>
                  ) : (
                    group.projects.map((p) => (
                      <Link key={p.id} href={`/projects/${p.name}`}>
                        <Badge variant="secondary" className="text-xs hover:bg-accent">
                          {p.displayName}
                        </Badge>
                      </Link>
                    ))
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openEdit(group)}
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteId(group.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Edit Sheet */}
      <BottomSheet open={editOpen} onOpenChange={setEditOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Edit group</BottomSheetTitle>
            <BottomSheetDescription>
              Update group name and color.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="group-name">Name</Label>
                <Input
                  id="group-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label>Color</Label>
                <div className="flex flex-wrap gap-2">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setEditColor(c)}
                      className={`size-8 rounded-full transition-all ${
                        editColor === c
                          ? "ring-2 ring-offset-2 ring-offset-background"
                          : "hover:scale-110"
                      }`}
                      style={{
                        backgroundColor: c,
                        ringColor: editColor === c ? c : undefined,
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          <BottomSheetFooter>
            <Button
              variant="outline"
              onClick={() => setEditOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !editName.trim()}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>

      {/* Delete Confirmation */}
      <ConfirmDeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete group"
        description="Projects in this group will become ungrouped. This won't delete the projects themselves."
      />
    </>
  );
}
