"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  HardDrive,
  Plus,
  X,
  ShieldCheck,
  Clock,
  Gauge,
  Pencil,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";

type Volume = {
  name: string;
  mountPath: string;
  type: "named" | "anonymous" | "bind";
  persistent: boolean;
  source: string;
};

type VolumeLimit = {
  maxSizeBytes: number;
  warnAtPercent: number;
} | null;

type Props = {
  projectId: string;
  orgId: string;
};

function formatMB(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function VolumesPanel({ projectId, orgId }: Props) {
  const router = useRouter();
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMountPath, setNewMountPath] = useState("");

  // Volume limit state
  const [limit, setLimit] = useState<VolumeLimit>(null);
  const [limitLoading, setLimitLoading] = useState(true);
  const [limitEditing, setLimitEditing] = useState(false);
  const [limitSaving, setLimitSaving] = useState(false);
  const [limitSizeMB, setLimitSizeMB] = useState("");
  const [limitWarnPercent, setLimitWarnPercent] = useState("80");

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(
          `/api/v1/organizations/${orgId}/projects/${projectId}/volumes`
        );
        if (res.ok) {
          const data = await res.json();
          setVolumes(data.volumes || []);
        }
      } catch { /* noop */ }
      finally { setLoading(false); }
    }
    load();
  }, [orgId, projectId]);

  useEffect(() => {
    async function loadLimit() {
      try {
        const res = await fetch(
          `/api/v1/organizations/${orgId}/projects/${projectId}/volumes/limits`
        );
        if (res.ok) {
          const data = await res.json();
          setLimit(data.limit);
          if (data.limit) {
            setLimitSizeMB(String(Math.round(data.limit.maxSizeBytes / (1024 * 1024))));
            setLimitWarnPercent(String(data.limit.warnAtPercent ?? 80));
          }
        }
      } catch { /* noop */ }
      finally { setLimitLoading(false); }
    }
    loadLimit();
  }, [orgId, projectId]);

  async function togglePersistent(volumeName: string) {
    const updated = volumes.map((v) =>
      v.name === volumeName ? { ...v, persistent: !v.persistent } : v
    );
    setVolumes(updated);

    // Save persistent volumes config
    const persistent = updated
      .filter((v) => v.persistent)
      .map((v) => ({ name: v.name, mountPath: v.mountPath }));

    setSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/volumes`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ volumes: persistent }),
        }
      );
      if (res.ok) {
        toast.success(
          updated.find((v) => v.name === volumeName)?.persistent
            ? "Volume marked as persistent"
            : "Volume marked as ephemeral"
        );
      }
    } catch {
      toast.error("Failed to update");
    } finally {
      setSaving(false);
    }
  }

  async function addVolume() {
    if (!newName.trim() || !newMountPath.trim()) return;

    const newVol: Volume = {
      name: newName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      mountPath: newMountPath.trim(),
      type: "named",
      persistent: true,
      source: newName.trim(),
    };

    const updated = [...volumes, newVol];
    setVolumes(updated);

    const persistent = updated
      .filter((v) => v.persistent)
      .map((v) => ({ name: v.name, mountPath: v.mountPath }));

    setSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/volumes`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ volumes: persistent }),
        }
      );
      if (res.ok) {
        toast.success("Volume added");
        setAddOpen(false);
        setNewName("");
        setNewMountPath("");
      }
    } catch {
      toast.error("Failed to add volume");
    } finally {
      setSaving(false);
    }
  }

  async function removeVolume(volumeName: string) {
    const updated = volumes.filter((v) => v.name !== volumeName);
    setVolumes(updated);

    const persistent = updated
      .filter((v) => v.persistent)
      .map((v) => ({ name: v.name, mountPath: v.mountPath }));

    try {
      await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/volumes`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ volumes: persistent }),
        }
      );
      toast.success("Volume removed");
    } catch {
      toast.error("Failed to remove volume");
    }
  }

  async function saveLimit() {
    const sizeMB = parseInt(limitSizeMB);
    const warnPercent = parseInt(limitWarnPercent);

    if (!sizeMB || sizeMB <= 0) {
      toast.error("Size must be a positive number");
      return;
    }
    if (!warnPercent || warnPercent < 1 || warnPercent > 100) {
      toast.error("Warn threshold must be between 1 and 100");
      return;
    }

    setLimitSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/volumes/limits`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            maxSizeBytes: sizeMB * 1024 * 1024,
            warnAtPercent: warnPercent,
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        setLimit(data.limit);
        setLimitEditing(false);
        toast.success("Volume limit saved");
      } else {
        toast.error("Failed to save limit");
      }
    } catch {
      toast.error("Failed to save limit");
    } finally {
      setLimitSaving(false);
    }
  }

  async function removeLimit() {
    setLimitSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/volumes/limits`,
        { method: "DELETE" }
      );
      if (res.ok) {
        setLimit(null);
        setLimitSizeMB("");
        setLimitWarnPercent("80");
        setLimitEditing(false);
        toast.success("Volume limit removed");
      }
    } catch {
      toast.error("Failed to remove limit");
    } finally {
      setLimitSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Persistent volumes survive deployments. Ephemeral volumes are recreated each deploy.
          </p>
          <Button
            size="sm"
            onClick={() => {
              setNewName("");
              setNewMountPath("");
              setAddOpen(true);
            }}
          >
            <Plus className="mr-1.5 size-4" />
            Add Volume
          </Button>
        </div>

        {volumes.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
            <HardDrive className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No volumes configured. Deploy the project to see detected volumes, or add one manually.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {volumes.map((vol) => (
              <div
                key={`${vol.name}-${vol.mountPath}`}
                className="squircle flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
              >
                <div className="flex items-center gap-4 min-w-0 flex-1">
                  <HardDrive className="size-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium font-mono truncate">
                        {vol.name}
                      </p>
                      <Badge variant="secondary" className="text-xs shrink-0">
                        {vol.type}
                      </Badge>
                      {vol.persistent ? (
                        <Badge className="text-xs shrink-0 border-transparent bg-status-success-muted text-status-success">
                          <ShieldCheck className="mr-1 size-3" />
                          Persistent
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs shrink-0">
                          <Clock className="mr-1 size-3" />
                          Ephemeral
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                      {vol.mountPath}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Switch
                    checked={vol.persistent}
                    onCheckedChange={() => togglePersistent(vol.name)}
                    disabled={saving}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removeVolume(vol.name)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Volume Size Limit */}
      {!limitLoading && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Gauge className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Storage Limit</h3>
          </div>

          {limitEditing ? (
            <div className="squircle rounded-lg border bg-card p-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="limit-size">Max Size (MB)</Label>
                  <Input
                    id="limit-size"
                    type="number"
                    min="1"
                    placeholder="1024"
                    className="font-mono"
                    value={limitSizeMB}
                    onChange={(e) => setLimitSizeMB(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="limit-warn">Warn at (%)</Label>
                  <Input
                    id="limit-warn"
                    type="number"
                    min="1"
                    max="100"
                    placeholder="80"
                    className="font-mono"
                    value={limitWarnPercent}
                    onChange={(e) => setLimitWarnPercent(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                A warning will be logged during deploys when volume usage exceeds the threshold.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={saveLimit}
                  disabled={limitSaving}
                >
                  {limitSaving ? (
                    <><Loader2 className="mr-2 size-4 animate-spin" />Saving...</>
                  ) : (
                    "Save Limit"
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setLimitEditing(false);
                    if (limit) {
                      setLimitSizeMB(String(Math.round(limit.maxSizeBytes / (1024 * 1024))));
                      setLimitWarnPercent(String(limit.warnAtPercent ?? 80));
                    }
                  }}
                  disabled={limitSaving}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : limit ? (
            <div className="squircle flex items-center justify-between rounded-lg border bg-card p-4">
              <div className="space-y-0.5">
                <p className="text-sm">
                  Max: <span className="font-mono font-medium">{formatMB(limit.maxSizeBytes)}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Warning at {limit.warnAtPercent}% usage
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setLimitEditing(true)}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={removeLimit}
                  disabled={limitSaving}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                setLimitSizeMB("");
                setLimitWarnPercent("80");
                setLimitEditing(true);
              }}
              className="squircle w-full rounded-lg border border-dashed p-4 text-sm text-muted-foreground hover:bg-accent/50 transition-colors text-left"
            >
              No storage limit set. Click to add a size limit with deploy-time warnings.
            </button>
          )}
        </div>
      )}

      <BottomSheet open={addOpen} onOpenChange={setAddOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Add volume</BottomSheetTitle>
            <BottomSheetDescription>
              Map a named volume to a container path. Persistent volumes survive across deployments.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="vol-name">Volume Name</Label>
                <Input
                  id="vol-name"
                  placeholder="data"
                  className="font-mono"
                  value={newName}
                  onChange={(e) =>
                    setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="vol-path">Container Path</Label>
                <Input
                  id="vol-path"
                  placeholder="/var/lib/data"
                  className="font-mono"
                  value={newMountPath}
                  onChange={(e) => setNewMountPath(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The path inside the container where this volume will be mounted.
                </p>
              </div>
            </div>
          </div>

          <BottomSheetFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={addVolume}
              disabled={saving || !newName.trim() || !newMountPath.trim()}
            >
              {saving ? (
                <><Loader2 className="mr-2 size-4 animate-spin" />Adding...</>
              ) : (
                "Add Volume"
              )}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>
    </div>
  );
}
