"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Loader2,
  RefreshCw,
  Server,
  FolderOpen,
  Download,
  Play,
  Check,
  AlertCircle,
} from "lucide-react";
import { toast } from "@/lib/messenger";

type ContainerInfo = {
  name: string;
  status: string;
  health: string | null;
  uptime: string | null;
};

type UpdateStatus = {
  currentCommit: string;
  latestCommit: string;
  behindBy: number;
  updateAvailable: boolean;
  commits: Array<{ hash: string; message: string }>;
};

type MountsConfig = {
  mount1: string | null;
  mount2: string | null;
  mount3: string | null;
};

export function MaintenanceSettings() {
  const [loading, setLoading] = useState(true);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [mounts, setMounts] = useState<MountsConfig>({ mount1: null, mount2: null, mount3: null });
  const [restartingService, setRestartingService] = useState<string | null>(null);
  const [restartingAll, setRestartingAll] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [savingMounts, setSavingMounts] = useState(false);

  async function fetchAll() {
    try {
      const [containersRes, updateRes, mountsRes] = await Promise.all([
        fetch("/api/v1/admin/maintenance"),
        fetch("/api/v1/admin/maintenance/update"),
        fetch("/api/v1/admin/maintenance/mounts"),
      ]);

      if (containersRes.ok) {
        const data = await containersRes.json();
        setContainers(data.containers || []);
      }

      if (updateRes.ok) {
        setUpdateStatus(await updateRes.json());
      }

      if (mountsRes.ok) {
        const mountsData = await mountsRes.json();
        setMounts({
          mount1: mountsData.mount1 || "",
          mount2: mountsData.mount2 || "",
          mount3: mountsData.mount3 || "",
        });
      }
    } catch {
      // Failed to load
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchAll();
  }, []);

  async function handleRestartService(service?: string) {
    if (service) {
      setRestartingService(service);
    } else {
      setRestartingAll(true);
    }

    try {
      const res = await fetch("/api/v1/admin/maintenance/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(service ? { service } : {}),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to restart");
      }

      toast.success(service ? `Restarting ${service}...` : "Restarting all services...", {
        description: "This may take a moment.",
      });

      // Refresh container list after a delay
      setTimeout(fetchAll, 3000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to restart");
    } finally {
      setRestartingService(null);
      setRestartingAll(false);
    }
  }

  async function handleCheckUpdates() {
    setCheckingUpdates(true);
    try {
      const res = await fetch("/api/v1/admin/maintenance/update");
      if (res.ok) {
        const data = await res.json();
        setUpdateStatus(data);
        if (!data.updateAvailable) {
          toast.success("Already up to date");
        }
      }
    } catch {
      toast.error("Failed to check for updates");
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function handleApplyUpdate() {
    setApplyingUpdate(true);
    try {
      const res = await fetch("/api/v1/admin/maintenance/update", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to apply update");
      }

      toast.success("Update started", {
        description: "Vardo will rebuild and restart. This page will refresh automatically.",
      });

      // Refresh after some time
      setTimeout(() => window.location.reload(), 30000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to apply update");
      setApplyingUpdate(false);
    }
  }

  async function handleSaveMounts(e: React.FormEvent) {
    e.preventDefault();
    setSavingMounts(true);

    try {
      const res = await fetch("/api/v1/admin/maintenance/mounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mounts),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }

      const data = await res.json();
      toast.success("Mount configuration saved", {
        description: data.restartRequired ? "Restart Vardo to apply changes." : undefined,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save mounts");
    } finally {
      setSavingMounts(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Maintenance</h2>
        <p className="text-sm text-muted-foreground">
          Manage the Vardo stack, check for updates, and configure mounts.
        </p>
      </div>

      {/* Services */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Server className="size-4" />
            Stack Services
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {containers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No Vardo containers found. Make sure the stack is running.
            </p>
          ) : (
            <div className="space-y-2">
              {containers.map((container) => (
                <div
                  key={container.name}
                  className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <div>
                      <p className="text-sm font-medium">{container.name}</p>
                      {container.uptime && (
                        <p className="text-xs text-muted-foreground">Up {container.uptime}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={
                        container.status === "running"
                          ? container.health === "healthy"
                            ? "text-status-success border-status-success"
                            : container.health === "unhealthy"
                              ? "text-status-error border-status-error"
                              : "text-status-success border-status-success"
                          : "text-status-warning border-status-warning"
                      }
                    >
                      {container.health === "healthy" && <Check className="size-3 mr-1" />}
                      {container.health === "unhealthy" && <AlertCircle className="size-3 mr-1" />}
                      {container.status === "running" ? (container.health || "running") : container.status}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRestartService(container.name.replace("vardo-", ""))}
                      disabled={restartingService === container.name.replace("vardo-", "") || restartingAll}
                    >
                      {restartingService === container.name.replace("vardo-", "") ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <Button
            variant="outline"
            onClick={() => handleRestartService()}
            disabled={restartingAll || restartingService !== null}
            className="squircle"
          >
            {restartingAll ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Restarting...
              </>
            ) : (
              <>
                <RefreshCw className="size-4" />
                Restart All
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Updates */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Download className="size-4" />
            Updates
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {updateStatus ? (
            <div className="space-y-3">
              <div className="flex items-center gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Current: </span>
                  <code className="px-1.5 py-0.5 bg-muted rounded font-mono">
                    {updateStatus.currentCommit}
                  </code>
                </div>
                <div>
                  <span className="text-muted-foreground">Latest: </span>
                  <code className="px-1.5 py-0.5 bg-muted rounded font-mono">
                    {updateStatus.latestCommit}
                  </code>
                </div>
              </div>

              {updateStatus.updateAvailable ? (
                <div className="space-y-2">
                  <Badge variant="outline" className="text-status-info border-status-info">
                    {updateStatus.behindBy} update{updateStatus.behindBy === 1 ? "" : "s"} available
                  </Badge>
                  {updateStatus.commits.length > 0 && (
                    <ul className="text-xs space-y-1 max-h-24 overflow-y-auto">
                      {updateStatus.commits.slice(0, 5).map((commit) => (
                        <li key={commit.hash} className="text-muted-foreground">
                          <code className="text-foreground">{commit.hash}</code> {commit.message}
                        </li>
                      ))}
                      {updateStatus.commits.length > 5 && (
                        <li className="text-muted-foreground">
                          ...and {updateStatus.commits.length - 5} more
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              ) : (
                <Badge variant="outline" className="text-status-success border-status-success">
                  <Check className="size-3 mr-1" />
                  Up to date
                </Badge>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Unable to check for updates. VARDO_DIR may not be configured.
            </p>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleCheckUpdates}
              disabled={checkingUpdates || applyingUpdate}
              className="squircle"
            >
              {checkingUpdates ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Checking...
                </>
              ) : (
                <>
                  <RefreshCw className="size-4" />
                  Check for Updates
                </>
              )}
            </Button>
            {updateStatus?.updateAvailable && (
              <Button
                onClick={handleApplyUpdate}
                disabled={applyingUpdate}
                className="squircle"
              >
                {applyingUpdate ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Updating...
                  </>
                ) : (
                  <>
                    <Play className="size-4" />
                    Update Now
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Mounts */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <FolderOpen className="size-4" />
            Volume Mounts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveMounts} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Configure additional read-only mounts for external project access. Changes require a restart.
            </p>

            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="mount1">Mount 1</Label>
                <Input
                  id="mount1"
                  placeholder="/path/to/directory"
                  value={mounts.mount1 || ""}
                  onChange={(e) => setMounts((m) => ({ ...m, mount1: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mount2">Mount 2</Label>
                <Input
                  id="mount2"
                  placeholder="/path/to/directory"
                  value={mounts.mount2 || ""}
                  onChange={(e) => setMounts((m) => ({ ...m, mount2: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mount3">Mount 3</Label>
                <Input
                  id="mount3"
                  placeholder="/path/to/directory"
                  value={mounts.mount3 || ""}
                  onChange={(e) => setMounts((m) => ({ ...m, mount3: e.target.value }))}
                />
              </div>
            </div>

            <Button type="submit" disabled={savingMounts} className="squircle">
              {savingMounts && <Loader2 className="size-4 animate-spin" />}
              Save Mounts
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
