"use client";

import { useState, useEffect, useCallback } from "react";
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
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";

import { volumeThreshold, type ThresholdLevel } from "@/lib/volumes/threshold";

type Volume = {
  name: string;
  mountPath: string;
  type: "named" | "anonymous" | "bind";
  persistent: boolean;
  source: string;
  sizeBytes: number | null;
};

type VolumeLimit = {
  maxSizeBytes: number;
  warnAtPercent: number;
} | null;

type Props = {
  appId: string;
  orgId: string;
};

const MIN_SIZE_MB = 10;
const MAX_SIZE_MB = 100 * 1024; // 100 GB in MB

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function toBytes(value: number, unit: "MB" | "GB"): number {
  return unit === "GB" ? value * 1024 * 1024 * 1024 : value * 1024 * 1024;
}

function fromBytes(bytes: number): { value: number; unit: "MB" | "GB" } {
  if (bytes >= 1024 * 1024 * 1024) {
    const gb = bytes / (1024 * 1024 * 1024);
    // Use GB if it's a clean number
    if (gb === Math.floor(gb) || gb >= 1) {
      return { value: parseFloat(gb.toFixed(1)), unit: "GB" };
    }
  }
  return { value: Math.round(bytes / (1024 * 1024)), unit: "MB" };
}

function thresholdTextClass(level: ThresholdLevel): string {
  if (level === "critical") return "text-destructive font-medium";
  if (level === "warning") return "text-amber-500 font-medium";
  return "text-muted-foreground";
}

function thresholdProgressClass(level: ThresholdLevel): string {
  if (level === "critical") return "h-1.5 [&>[data-slot=progress-indicator]]:bg-destructive";
  if (level === "warning") return "h-1.5 [&>[data-slot=progress-indicator]]:bg-amber-500";
  return "h-1.5";
}

export function VolumesPanel({ appId, orgId }: Props) {
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
  const [limitSize, setLimitSize] = useState("");
  const [limitUnit, setLimitUnit] = useState<"MB" | "GB">("MB");
  const [limitWarnPercent, setLimitWarnPercent] = useState("80");

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(
          `/api/v1/organizations/${orgId}/apps/${appId}/volumes`
        );
        if (res.ok) {
          const data = await res.json();
          setVolumes(data.volumes || []);
        }
      } catch { /* noop */ }
      finally { setLoading(false); }
    }
    load();
  }, [orgId, appId]);

  useEffect(() => {
    async function loadLimit() {
      try {
        const res = await fetch(
          `/api/v1/organizations/${orgId}/apps/${appId}/volumes/limits`
        );
        if (res.ok) {
          const data = await res.json();
          setLimit(data.limit);
          if (data.limit) {
            const { value, unit } = fromBytes(data.limit.maxSizeBytes);
            setLimitSize(String(value));
            setLimitUnit(unit);
            setLimitWarnPercent(String(data.limit.warnAtPercent ?? 80));
          }
        }
      } catch { /* noop */ }
      finally { setLimitLoading(false); }
    }
    loadLimit();
  }, [orgId, appId]);

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
        `/api/v1/organizations/${orgId}/apps/${appId}/volumes`,
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
      sizeBytes: null,
    };

    const updated = [...volumes, newVol];
    setVolumes(updated);

    const persistent = updated
      .filter((v) => v.persistent)
      .map((v) => ({ name: v.name, mountPath: v.mountPath }));

    setSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/volumes`,
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
        `/api/v1/organizations/${orgId}/apps/${appId}/volumes`,
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
    const sizeNum = parseFloat(limitSize);
    const warnPercent = parseInt(limitWarnPercent);

    if (!sizeNum || sizeNum <= 0) {
      toast.error("Size must be a positive number");
      return;
    }

    const sizeBytes = toBytes(sizeNum, limitUnit);
    const sizeMB = sizeBytes / (1024 * 1024);

    if (sizeMB < MIN_SIZE_MB) {
      toast.error("Minimum size is 10 MB");
      return;
    }
    if (sizeMB > MAX_SIZE_MB) {
      toast.error("Maximum size is 100 GB");
      return;
    }

    if (!warnPercent || warnPercent < 1 || warnPercent > 100) {
      toast.error("Warn threshold must be between 1 and 100");
      return;
    }

    setLimitSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/volumes/limits`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            maxSizeBytes: sizeBytes,
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
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to save limit");
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
        `/api/v1/organizations/${orgId}/apps/${appId}/volumes/limits`,
        { method: "DELETE" }
      );
      if (res.ok) {
        setLimit(null);
        setLimitSize("");
        setLimitUnit("MB");
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

  // Check if any volume exceeds the limit (for summary display)
  const anyOverLimit = limit
    ? volumes.some((v) => v.sizeBytes != null && v.sizeBytes > limit.maxSizeBytes)
    : false;

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
                  <div className="min-w-0 flex-1">
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
                    {/* Per-volume usage vs limit */}
                    {vol.sizeBytes != null && vol.sizeBytes > 0 && limit && (() => {
                      const level = volumeThreshold(vol.sizeBytes!, limit.maxSizeBytes, limit.warnAtPercent ?? 80);
                      const percent = Math.round((vol.sizeBytes! / limit.maxSizeBytes) * 100);
                      return (
                        <div className="mt-2 space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">
                              {formatBytes(vol.sizeBytes!)} / {formatBytes(limit.maxSizeBytes)}
                            </span>
                            <span className={thresholdTextClass(level)}>
                              {percent}%
                            </span>
                          </div>
                          <Progress
                            value={Math.min(percent, 100)}
                            className={thresholdProgressClass(level)}
                          />
                        </div>
                      );
                    })()}
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
                  <Label htmlFor="limit-size">Max Size</Label>
                  <div className="flex gap-2">
                    <Input
                      id="limit-size"
                      type="number"
                      min={limitUnit === "GB" ? "0.01" : "10"}
                      max={limitUnit === "GB" ? "100" : String(MAX_SIZE_MB)}
                      step={limitUnit === "GB" ? "0.1" : "1"}
                      placeholder={limitUnit === "GB" ? "2" : "1024"}
                      className="font-mono flex-1"
                      value={limitSize}
                      onChange={(e) => setLimitSize(e.target.value)}
                    />
                    <Select
                      value={limitUnit}
                      onValueChange={(val: "MB" | "GB") => {
                        // Convert the current value when switching units
                        const current = parseFloat(limitSize);
                        if (current && !isNaN(current)) {
                          if (val === "GB" && limitUnit === "MB") {
                            setLimitSize(String(parseFloat((current / 1024).toFixed(2))));
                          } else if (val === "MB" && limitUnit === "GB") {
                            setLimitSize(String(Math.round(current * 1024)));
                          }
                        }
                        setLimitUnit(val);
                      }}
                    >
                      <SelectTrigger className="w-20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MB">MB</SelectItem>
                        <SelectItem value="GB">GB</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Min 10 MB, max 100 GB
                  </p>
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
                  <p className="text-xs text-muted-foreground">
                    Warning logged during deploys at this threshold
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Deploys will be <span className="font-medium text-destructive">blocked</span> when
                any individual volume exceeds this limit. A warning is logged at the threshold percentage.
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
                      const { value, unit } = fromBytes(limit.maxSizeBytes);
                      setLimitSize(String(value));
                      setLimitUnit(unit);
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
            <div className="squircle rounded-lg border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm">
                    Max: <span className="font-mono font-medium">{formatBytes(limit.maxSizeBytes)}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Warning at {limit.warnAtPercent}% &middot; Blocks deploy above 100%
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

              {anyOverLimit && (
                <p className="text-xs text-destructive font-medium flex items-center gap-1.5">
                  <AlertTriangle className="size-3" />
                  One or more volumes exceed the limit. Deploys will be blocked until usage is reduced.
                </p>
              )}
            </div>
          ) : (
            <button
              onClick={() => {
                setLimitSize("");
                setLimitUnit("MB");
                setLimitWarnPercent("80");
                setLimitEditing(true);
              }}
              className="squircle w-full rounded-lg border border-dashed p-4 text-sm text-muted-foreground hover:bg-accent/50 transition-colors text-left"
            >
              No storage limit set. Click to add a size limit that blocks deploys when exceeded.
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
