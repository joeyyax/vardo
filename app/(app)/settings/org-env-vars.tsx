"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Pencil, X, EyeOff, Eye } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";

type OrgVar = {
  id: string;
  key: string;
  value: string;
  description: string | null;
  isSecret: boolean | null;
};

type Props = {
  orgId: string;
  initialVars: OrgVar[];
};

export function OrgEnvVarsEditor({ orgId, initialVars }: Props) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());

  // Form state
  const [editId, setEditId] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [isSecret, setIsSecret] = useState(false);

  function resetForm() {
    setEditId(null);
    setKey("");
    setValue("");
    setDescription("");
    setIsSecret(false);
  }

  function openAdd() {
    resetForm();
    setEditOpen(true);
  }

  function openEdit(v: OrgVar) {
    setEditId(v.id);
    setKey(v.key);
    setValue(v.value);
    setDescription(v.description || "");
    setIsSecret(v.isSecret ?? false);
    setEditOpen(true);
  }

  async function handleSave() {
    if (!key.trim()) return;
    setSaving(true);
    try {
      if (editId) {
        // Update via PUT with single var
        const res = await fetch(`/api/v1/organizations/${orgId}/env-vars`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vars: [{ key: key.trim(), value, isSecret }],
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          toast.error(data.error || "Failed to update");
          return;
        }
        toast.success("Variable updated");
      } else {
        const res = await fetch(`/api/v1/organizations/${orgId}/env-vars`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: key.trim(),
            value,
            description: description.trim() || undefined,
            isSecret,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          toast.error(data.error || "Failed to create");
          return;
        }
        toast.success("Variable added");
      }
      setEditOpen(false);
      resetForm();
      router.refresh();
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/env-vars`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        toast.error("Failed to delete");
        return;
      }
      toast.success("Variable deleted");
      router.refresh();
    } catch {
      toast.error("Failed to delete");
    } finally {
      setDeletingId(null);
    }
  }

  function toggleReveal(id: string) {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            Shared across all projects. Reference with{" "}
            <code className="bg-muted px-1 py-0.5 rounded text-xs">{"${org.VAR_NAME}"}</code>
          </p>
        </div>
        <Button size="sm" onClick={openAdd}>
          <Plus className="mr-1.5 size-4" />
          Add Variable
        </Button>
      </div>

      {initialVars.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <p className="text-sm text-muted-foreground">
            No shared variables configured.
          </p>
          <p className="text-xs text-muted-foreground">
            Add variables here that can be referenced from any project.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {initialVars.map((v) => (
            <div
              key={v.id}
              className="squircle flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
            >
              <div className="flex items-center gap-4 min-w-0 flex-1">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium font-mono">{v.key}</p>
                    {v.isSecret && (
                      <EyeOff className="size-3.5 text-muted-foreground" />
                    )}
                  </div>
                  {v.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {v.description}
                    </p>
                  )}
                </div>
                {v.value && (
                  <div className="flex items-center gap-1.5 ml-auto mr-4">
                    <span className="text-xs font-mono text-muted-foreground truncate max-w-[200px]">
                      {v.isSecret && !revealedIds.has(v.id) ? "••••••••" : v.value}
                    </span>
                    {v.isSecret && (
                      <button
                        type="button"
                        onClick={() => toggleReveal(v.id)}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {revealedIds.has(v.id) ? (
                          <EyeOff className="size-3" />
                        ) : (
                          <Eye className="size-3" />
                        )}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => openEdit(v)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={deletingId === v.id}
                  onClick={() => handleDelete(v.id)}
                >
                  {deletingId === v.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <X className="size-3.5" />
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <BottomSheet
        open={editOpen}
        onOpenChange={(v) => {
          setEditOpen(v);
          if (!v) resetForm();
        }}
      >
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>
              {editId ? "Edit variable" : "Add shared variable"}
            </BottomSheetTitle>
            <BottomSheetDescription>
              {editId
                ? "Update this organization-level variable."
                : "Available to all projects via ${org.KEY}."}
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="org-var-key">Key</Label>
                <Input
                  id="org-var-key"
                  placeholder="SHARED_API_KEY"
                  className="font-mono"
                  value={key}
                  disabled={!!editId}
                  onChange={(e) =>
                    setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))
                  }
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="org-var-value">Value</Label>
                <Input
                  id="org-var-value"
                  placeholder="Enter value"
                  className="font-mono"
                  type={isSecret ? "password" : "text"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="org-var-desc">Description</Label>
                <Input
                  id="org-var-desc"
                  placeholder="Optional — what this variable is for"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  id="org-var-secret"
                  checked={isSecret}
                  onCheckedChange={setIsSecret}
                />
                <Label htmlFor="org-var-secret">Secret</Label>
                <span className="text-xs text-muted-foreground">
                  Secret values are masked in the UI
                </span>
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
              disabled={saving || !key.trim()}
            >
              {saving ? (
                <><Loader2 className="mr-2 size-4 animate-spin" />Saving...</>
              ) : editId ? (
                "Update"
              ) : (
                "Add Variable"
              )}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>
    </div>
  );
}
