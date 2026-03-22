"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Loader2,
  X,
  Copy,
  Globe2,
  Variable,
  Pencil,
  ArrowUp,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";

type Environment = {
  id: string;
  name: string;
  type: "production" | "staging" | "preview";
  domain: string | null;
  isDefault: boolean | null;
  createdAt: Date;
};

type AppEnvironmentsProps = {
  appId: string;
  orgId: string;
  environments: Environment[];
  envVarCounts?: Record<string, number>;
};

function EnvironmentTypeBadge({ type }: { type: Environment["type"] }) {
  switch (type) {
    case "production":
      return (
        <Badge className="border-transparent bg-status-success-muted text-status-success text-xs">
          production
        </Badge>
      );
    case "staging":
      return (
        <Badge className="border-transparent bg-status-warning-muted text-status-warning text-xs">
          staging
        </Badge>
      );
    case "preview":
      return (
        <Badge className="border-transparent bg-status-info-muted text-status-info text-xs">
          preview
        </Badge>
      );
  }
}

export function AppEnvironments({
  appId,
  orgId,
  environments,
  envVarCounts = {},
}: AppEnvironmentsProps) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"production" | "staging" | "preview">("staging");
  const [newDomain, setNewDomain] = useState("");

  const [cloning, setCloning] = useState<string | null>(null);
  const [cloneName, setCloneName] = useState("");
  const [cloneSaving, setCloneSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDomain, setEditDomain] = useState("");

  const [deleteTarget, setDeleteTarget] = useState<Environment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [promoteTarget, setPromoteTarget] = useState<Environment | null>(null);
  const [promoting, setPromoting] = useState(false);

  async function handleCreate() {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/environments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newName.trim(),
            type: newType,
            domain: newDomain.trim() || undefined,
          }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to create environment");
        return;
      }

      toast.success("Environment created");
      setCreating(false);
      setNewName("");
      setNewDomain("");
      router.refresh();
    } catch {
      toast.error("Failed to create environment");
    } finally {
      setSaving(false);
    }
  }

  async function handleClone(sourceId: string) {
    if (!cloneName.trim()) return;
    setCloneSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/environments/${sourceId}/clone`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: cloneName.trim(),
          }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to clone environment");
        return;
      }

      const data = await res.json();
      toast.success(`Cloned with ${data.clonedVars} variables`);
      setCloning(null);
      setCloneName("");
      router.refresh();
    } catch {
      toast.error("Failed to clone environment");
    } finally {
      setCloneSaving(false);
    }
  }

  async function handleUpdateDomain(envId: string) {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/environments/${envId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            domain: editDomain.trim() || null,
          }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to update environment");
        return;
      }

      toast.success("Environment updated");
      setEditingId(null);
      router.refresh();
    } catch {
      toast.error("Failed to update environment");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/environments/${deleteTarget.id}`,
        { method: "DELETE" }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to delete environment");
        return;
      }

      toast.success("Environment deleted");
      setDeleteTarget(null);
      router.refresh();
    } catch {
      toast.error("Failed to delete environment");
    } finally {
      setDeleting(false);
    }
  }

  async function confirmPromote() {
    if (!promoteTarget) return;
    setPromoting(true);
    try {
      // Clone this environment's vars into production
      const prodEnv = allEnvironments.find((e) => e.type === "production");
      if (!prodEnv) {
        toast.error("No production environment found");
        return;
      }

      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/environments/${promoteTarget.id}/clone`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `promote-${Date.now()}`,
            targetEnvironmentId: prodEnv.id,
          }),
        }
      );

      if (!res.ok) {
        // Fallback: just notify that promotion needs manual var copy for now
        toast.error("Promotion requires manually copying variables to production");
        return;
      }

      toast.success(`Promoted "${promoteTarget.name}" variables to production`);
      setPromoteTarget(null);
      router.refresh();
    } catch {
      toast.error("Failed to promote environment");
    } finally {
      setPromoting(false);
    }
  }

  // Always include a virtual production environment if none exists
  const hasProduction = environments.some((e) => e.type === "production");
  const allEnvironments: Environment[] = hasProduction
    ? environments
    : [
        {
          id: "__default_production__",
          name: "Production",
          type: "production" as const,
          domain: null,
          isDefault: true,
          createdAt: new Date(),
        },
        ...environments,
      ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Environments</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Separate configurations for production, staging, and preview deployments.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setCreating(!creating);
            setCloning(null);
          }}
        >
          <Plus className="mr-1.5 size-4" />
          Add environment
        </Button>
      </div>

      {/* Create form */}
      {creating && (
        <div className="flex items-end gap-3 rounded-lg border bg-card p-4">
          <div className="grid gap-1.5 flex-1">
            <label className="text-xs text-muted-foreground">Name</label>
            <input
              placeholder="staging"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              className="h-9 rounded-md border bg-background px-3 text-sm font-mono"
              autoFocus
            />
          </div>
          <div className="grid gap-1.5 w-36">
            <label className="text-xs text-muted-foreground">Type</label>
            <Select value={newType} onValueChange={(v) => setNewType(v as typeof newType)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="production">Production</SelectItem>
                <SelectItem value="staging">Staging</SelectItem>
                <SelectItem value="preview">Preview</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5 flex-1">
            <label className="text-xs text-muted-foreground">
              Domain <span className="text-muted-foreground/60">(optional)</span>
            </label>
            <input
              placeholder="staging.example.com"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              className="h-9 rounded-md border bg-background px-3 text-sm font-mono"
            />
          </div>
          <Button size="sm" onClick={handleCreate} disabled={saving || !newName.trim()}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Create"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </div>
      )}

      {/* Environment list */}
        <div className="space-y-2">
          {allEnvironments
            .sort((a, b) => {
              // Default first, then by type priority, then by name
              if (a.isDefault && !b.isDefault) return -1;
              if (!a.isDefault && b.isDefault) return 1;
              const typePriority = { production: 0, staging: 1, preview: 2 };
              const diff = typePriority[a.type] - typePriority[b.type];
              if (diff !== 0) return diff;
              return a.name.localeCompare(b.name);
            })
            .map((env) => {
              const isCloning = cloning === env.id;
              const isEditing = editingId === env.id;
              const canDelete = env.type !== "production" && !env.isDefault;
              const canPromote = env.type !== "production";
              const isVirtual = env.id === "__default_production__";
              const varCount = envVarCounts[env.id] ?? 0;

              return (
                <div
                  key={env.id}
                  className={`squircle rounded-lg border bg-card overflow-hidden ${
                    env.isDefault ? "border-primary/30" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-4 p-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`size-2 rounded-full shrink-0 ${
                          env.type === "production"
                            ? "bg-status-success"
                            : env.type === "staging"
                            ? "bg-status-warning"
                            : "bg-status-info"
                        }`}
                      />
                      <p className="text-sm font-medium">{env.name}</p>
                      <EnvironmentTypeBadge type={env.type} />
                      {env.isDefault && (
                        <Badge variant="secondary" className="text-xs">
                          default
                        </Badge>
                      )}
                      {varCount > 0 && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Variable className="size-3" />
                          {varCount}
                        </span>
                      )}
                      {env.domain && !isEditing && (
                        <a
                          href={`https://${env.domain}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs text-muted-foreground font-mono hover:text-foreground transition-colors truncate"
                        >
                          <Globe2 className="size-3 shrink-0" />
                          {env.domain}
                        </a>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {!isVirtual && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Edit domain"
                          onClick={() => {
                            setEditingId(isEditing ? null : env.id);
                            setEditDomain(env.domain || "");
                            setCloning(null);
                          }}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                      {!isVirtual && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Clone environment"
                          onClick={() => {
                            setCloning(isCloning ? null : env.id);
                            setCloneName(`${env.name}-copy`);
                            setEditingId(null);
                            setCreating(false);
                          }}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                      )}
                      {canPromote && !isVirtual && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Promote to production"
                          onClick={() => setPromoteTarget(env)}
                        >
                          <ArrowUp className="size-3.5" />
                        </Button>
                      )}
                      {canDelete && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Delete environment"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(env)}
                        >
                          <X className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Inline edit domain */}
                  {isEditing && (
                    <div className="border-t px-4 py-3 flex items-end gap-3">
                      <div className="grid gap-1.5 flex-1">
                        <label className="text-xs text-muted-foreground">Domain</label>
                        <input
                          placeholder="staging.example.com"
                          value={editDomain}
                          onChange={(e) => setEditDomain(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleUpdateDomain(env.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="h-9 rounded-md border bg-background px-3 text-sm font-mono"
                          autoFocus
                        />
                      </div>
                      <Button size="sm" onClick={() => handleUpdateDomain(env.id)}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  )}

                  {/* Inline clone form */}
                  {isCloning && (
                    <div className="border-t px-4 py-3 flex items-end gap-3">
                      <div className="grid gap-1.5 flex-1">
                        <label className="text-xs text-muted-foreground">
                          Clone as
                        </label>
                        <input
                          placeholder="staging-copy"
                          value={cloneName}
                          onChange={(e) => setCloneName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleClone(env.id);
                            if (e.key === "Escape") setCloning(null);
                          }}
                          className="h-9 rounded-md border bg-background px-3 text-sm font-mono"
                          autoFocus
                        />
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleClone(env.id)}
                        disabled={cloneSaving || !cloneName.trim()}
                      >
                        {cloneSaving ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          "Clone"
                        )}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setCloning(null)}>
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
        </div>

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        title="Delete environment"
        description={`Are you sure you want to delete "${deleteTarget?.name}"? All environment-specific variables will be removed. This cannot be undone.`}
        onConfirm={handleDelete}
        loading={deleting}
      />

      <ConfirmDeleteDialog
        open={!!promoteTarget}
        onOpenChange={(open) => {
          if (!open) setPromoteTarget(null);
        }}
        title="Promote to production"
        description={`Copy ${promoteTarget?.name} variables to production? Existing production variables won't be overwritten.`}
        confirmLabel="Promote"
        loadingLabel="Promoting..."
        variant="default"
        onConfirm={confirmPromote}
        loading={promoting}
      />
    </div>
  );
}
