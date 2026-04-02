"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Loader2,
  RefreshCw,
  ArrowUpCircle,
  HardDrive,
  Server,
  AlertCircle,
} from "lucide-react";
import { toast } from "@/lib/messenger";

type ServiceStatus = {
  name: string;
  containerId: string;
  status: string;
  state: string;
  image: string;
};

type MaintenanceStatus = {
  services: ServiceStatus[];
  hasVardoDir: boolean;
};

type MountsConfig = {
  vardoData: string | null;
  vardoProjects: string | null;
  vardoMount1: string | null;
  vardoMount2: string | null;
};

function stateVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  if (state === "running") return "default";
  if (state === "exited" || state === "dead") return "destructive";
  return "secondary";
}

function stateLabel(state: string): string {
  if (state === "running") return "Running";
  if (state === "exited") return "Exited";
  if (state === "restarting") return "Restarting";
  if (state === "paused") return "Paused";
  if (state === "dead") return "Dead";
  return state || "Unknown";
}

export function MaintenanceSettings() {
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingMounts, setLoadingMounts] = useState(true);
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [mounts, setMounts] = useState<MountsConfig>({
    vardoData: null,
    vardoProjects: null,
    vardoMount1: null,
    vardoMount2: null,
  });
  const [restarting, setRestarting] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [savingMounts, setSavingMounts] = useState(false);

  useEffect(() => {
    void fetchStatus();
    void fetchMounts();
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch("/api/v1/admin/maintenance");
      if (res.ok) {
        setStatus(await res.json());
      }
    } catch {
      // silently fail — service list stays empty
    } finally {
      setLoadingStatus(false);
    }
  }

  async function fetchMounts() {
    try {
      const res = await fetch("/api/v1/admin/maintenance/mounts");
      if (res.ok) {
        const data = await res.json();
        setMounts({
          vardoData: data.vardoData ?? "",
          vardoProjects: data.vardoProjects ?? "",
          vardoMount1: data.vardoMount1 ?? "",
          vardoMount2: data.vardoMount2 ?? "",
        });
      }
    } catch {
      // keep defaults
    } finally {
      setLoadingMounts(false);
    }
  }

  async function handleRestart(service?: string) {
    const key = service ?? "__all__";
    setRestarting(key);
    try {
      const res = await fetch("/api/v1/admin/maintenance/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(service ? { service } : {}),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      toast.success(data.message ?? "Restart initiated");
      if (!service || service === "vardo-frontend") {
        // Keep the button disabled through the reload window — don't clear restarting
        setTimeout(() => window.location.reload(), 6000);
        return;
      }
      // Re-fetch status so per-service badge reflects the new state
      void fetchStatus();
    } catch {
      toast.error(service ? `Failed to restart ${service}` : "Failed to restart services");
    } finally {
      // Only clear restarting if we're not waiting on a page reload
      if (service && service !== "vardo-frontend") {
        setRestarting(null);
      }
    }
  }

  async function handleUpdate() {
    setUpdating(true);
    try {
      const res = await fetch("/api/v1/admin/maintenance/update", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Update failed");
        return;
      }
      toast.success("Update initiated", {
        description: "Rebuilding and restarting in the background. The page will refresh automatically.",
      });
      setTimeout(() => window.location.reload(), 30000);
    } catch {
      toast.error("Failed to initiate update");
    } finally {
      setUpdating(false);
    }
  }

  async function handleSaveMounts(e: React.FormEvent) {
    e.preventDefault();
    setSavingMounts(true);
    try {
      // Send all fields — empty string clears the mount, non-empty sets it.
      // Fields that aren't absolute paths are omitted to avoid a 400.
      const payload: Record<string, string> = {};
      if (mounts.vardoData !== null) payload.vardoData = mounts.vardoData;
      if (mounts.vardoProjects !== null) payload.vardoProjects = mounts.vardoProjects;
      if (mounts.vardoMount1 !== null) payload.vardoMount1 = mounts.vardoMount1;
      if (mounts.vardoMount2 !== null) payload.vardoMount2 = mounts.vardoMount2;

      const res = await fetch("/api/v1/admin/maintenance/mounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? "Failed to save mounts");
        return;
      }
      toast.success("Mount configuration saved", {
        description: "Restart the stack to apply the new mounts.",
      });
    } catch {
      toast.error("Failed to save mount configuration");
    } finally {
      setSavingMounts(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Maintenance</h2>
        <p className="text-sm text-muted-foreground">
          Manage the Vardo stack — service status, restarts, updates, and volume mounts.
        </p>
      </div>

      {/* Service overview */}
      <Card className="squircle">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Server className="size-4" aria-hidden="true" />
            Services
          </CardTitle>
          <div className="flex items-center gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="squircle"
                  disabled={restarting !== null || updating}
                  aria-label="Restart all services"
                >
                  {restarting === "__all__" ? (
                    <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="size-3" aria-hidden="true" />
                  )}
                  {restarting === "__all__" ? "Restarting..." : "Restart all"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Restart all services?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will restart the entire Vardo stack and interrupt all active sessions.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleRestart()}>
                    Restart
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardHeader>
        <CardContent>
          {loadingStatus ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-5 animate-spin motion-reduce:animate-none text-muted-foreground" aria-hidden="true" />
            </div>
          ) : !status?.services.length ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              No Vardo services found. Make sure the docker socket is mounted.
            </div>
          ) : (
            <ul className="divide-y">
              {status.services.map((svc) => (
                <li
                  key={svc.containerId}
                  className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                >
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-sm font-mono">{svc.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{svc.status}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <Badge variant={stateVariant(svc.state)} className="text-xs">
                      {stateLabel(svc.state)}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="squircle h-7 px-2"
                      onClick={() => void handleRestart(svc.name)}
                      disabled={restarting !== null || updating}
                      aria-label={`Restart ${svc.name}`}
                    >
                      {restarting === svc.name ? (
                        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      ) : (
                        <RefreshCw className="size-3" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* One-click update */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <ArrowUpCircle className="size-4" aria-hidden="true" />
            Update Vardo
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Pull the latest code from git, rebuild the frontend image, and restart the stack.
            The current session will be interrupted while the container restarts.
          </p>
          {!loadingStatus && !status?.hasVardoDir && (
            <div className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
              <AlertCircle className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                <code className="text-xs font-mono">VARDO_HOME_DIR</code> is not set. Update requires
                access to the installation directory.
              </span>
            </div>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                disabled={updating || restarting !== null || loadingStatus || !status?.hasVardoDir}
                className="squircle"
              >
                {updating ? (
                  <>
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Updating...
                  </>
                ) : (
                  <>
                    <ArrowUpCircle className="size-4" aria-hidden="true" />
                    Pull &amp; rebuild
                  </>
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Pull and rebuild?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will run git pull, rebuild the frontend image, and restart the stack.
                  All active sessions will be interrupted during the restart.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleUpdate()}>
                  Update
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      {/* Mount configuration */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <HardDrive className="size-4" aria-hidden="true" />
            Host Mounts
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadingMounts ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-5 animate-spin motion-reduce:animate-none text-muted-foreground" aria-hidden="true" />
            </div>
          ) : (
            <form onSubmit={(e) => void handleSaveMounts(e)} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Host paths to mount into the Vardo container. Changes require a stack restart to
                take effect — the paths are written to <code className="text-xs font-mono">.env</code>.
                Leave a field blank to clear that mount.
              </p>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="vardo-data" className="text-sm">
                    Data directory{" "}
                    <span className="text-xs text-muted-foreground font-mono">(VARDO_DATA)</span>
                  </Label>
                  <Input
                    id="vardo-data"
                    placeholder="/mnt/data"
                    value={mounts.vardoData ?? ""}
                    onChange={(e) => setMounts((m) => ({ ...m, vardoData: e.target.value }))}
                    className="squircle font-mono text-sm"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vardo-projects" className="text-sm">
                    Projects directory{" "}
                    <span className="text-xs text-muted-foreground font-mono">(VARDO_PROJECTS)</span>
                  </Label>
                  <Input
                    id="vardo-projects"
                    placeholder="/home/user/projects"
                    value={mounts.vardoProjects ?? ""}
                    onChange={(e) => setMounts((m) => ({ ...m, vardoProjects: e.target.value }))}
                    className="squircle font-mono text-sm"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vardo-mount-1" className="text-sm">
                    Extra mount 1{" "}
                    <span className="text-xs text-muted-foreground font-mono">(VARDO_MOUNT_1)</span>
                  </Label>
                  <Input
                    id="vardo-mount-1"
                    placeholder="/path/to/mount"
                    value={mounts.vardoMount1 ?? ""}
                    onChange={(e) => setMounts((m) => ({ ...m, vardoMount1: e.target.value }))}
                    className="squircle font-mono text-sm"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vardo-mount-2" className="text-sm">
                    Extra mount 2{" "}
                    <span className="text-xs text-muted-foreground font-mono">(VARDO_MOUNT_2)</span>
                  </Label>
                  <Input
                    id="vardo-mount-2"
                    placeholder="/path/to/mount"
                    value={mounts.vardoMount2 ?? ""}
                    onChange={(e) => setMounts((m) => ({ ...m, vardoMount2: e.target.value }))}
                    className="squircle font-mono text-sm"
                  />
                </div>
              </div>

              <Button type="submit" className="squircle" disabled={savingMounts}>
                {savingMounts && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                Save mounts
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
