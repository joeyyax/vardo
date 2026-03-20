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

type Props = {
  projectId: string;
  orgId: string;
};

export function VolumesPanel({ projectId, orgId }: Props) {
  const router = useRouter();
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMountPath, setNewMountPath] = useState("");

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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
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
