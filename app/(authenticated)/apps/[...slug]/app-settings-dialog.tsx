"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/messenger";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BranchSelect } from "@/components/branch-select";

import type { App } from "./types";

export function AppSettingsDialog({
  app,
  orgId,
  userRole,
  open,
  onOpenChange,
  allParentApps,
  handleDeploy,
}: {
  app: App;
  orgId: string;
  userRole: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allParentApps: { id: string; name: string; color: string }[];
  handleDeploy: () => void;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  // Edit form state
  const [displayName, setDisplayName] = useState(app.displayName);
  const [description, setDescription] = useState(app.description || "");
  const [containerPort, setContainerPort] = useState(
    app.containerPort?.toString() || ""
  );
  const [autoPort, setAutoPort] = useState(!app.containerPort);
  const [editImageName, setEditImageName] = useState(app.imageName || "");
  const [restartPolicy, setRestartPolicy] = useState(app.restartPolicy || "unless-stopped");
  const [autoTraefikLabels, setAutoTraefikLabels] = useState(
    app.autoTraefikLabels ?? false
  );
  const [autoDeploy, setAutoDeploy] = useState(app.autoDeploy ?? false);
  const [gitBranch, setGitBranch] = useState(app.gitBranch || "");
  const [editDeployType, setEditDeployType] = useState(app.deployType);
  const [editComposeFilePath, setEditComposeFilePath] = useState(app.composeFilePath || "docker-compose.yml");
  const [editDockerfilePath, setEditDockerfilePath] = useState(app.dockerfilePath || "Dockerfile");
  const [rootDirectory, setRootDirectory] = useState(app.rootDirectory || "");
  const [editParentId, setEditParentId] = useState<string | null>(app.projectId ?? null);
  const [cpuLimit, setCpuLimit] = useState(app.cpuLimit?.toString() || "");
  const [memoryLimit, setMemoryLimit] = useState(app.memoryLimit?.toString() || "");
  const [gpuEnabled, setGpuEnabled] = useState(app.gpuEnabled ?? false);
  const [backendProtocol, setBackendProtocol] = useState<"auto" | "http" | "https">(app.backendProtocol || "auto");
  const [diskWriteAlertThreshold, setDiskWriteAlertThreshold] = useState(app.diskWriteAlertThreshold ? (app.diskWriteAlertThreshold / 1_073_741_824).toString() : "");
  const [healthCheckTimeout, setHealthCheckTimeout] = useState(app.healthCheckTimeout?.toString() || "60");
  const [autoRollback, setAutoRollback] = useState(app.autoRollback ?? false);
  const [rollbackGracePeriod, setRollbackGracePeriod] = useState(app.rollbackGracePeriod?.toString() || "60");

  async function handleSave() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        displayName: displayName.trim(),
        description: description.trim() || null,
        autoTraefikLabels,
        autoDeploy,
      };
      if (containerPort) {
        body.containerPort = parseInt(containerPort, 10);
      } else {
        body.containerPort = null;
      }
      body.deployType = editDeployType;
      if (editDeployType === "compose") {
        body.composeFilePath = editComposeFilePath || "docker-compose.yml";
      }
      if (editDeployType === "dockerfile") {
        body.dockerfilePath = editDockerfilePath || "Dockerfile";
      }
      if (app.source === "git") {
        body.gitBranch = gitBranch;
      }
      if (rootDirectory.trim()) {
        body.rootDirectory = rootDirectory.trim();
      } else {
        body.rootDirectory = null;
      }
      if (editImageName.trim()) body.imageName = editImageName.trim();
      body.restartPolicy = restartPolicy;
      body.cpuLimit = cpuLimit ? parseFloat(cpuLimit) : null;
      body.memoryLimit = memoryLimit ? parseInt(memoryLimit, 10) : null;
      body.gpuEnabled = gpuEnabled;
      body.backendProtocol = backendProtocol === "auto" ? null : backendProtocol;
      body.diskWriteAlertThreshold = diskWriteAlertThreshold ? Math.round(parseFloat(diskWriteAlertThreshold) * 1_073_741_824) : null;
      body.healthCheckTimeout = healthCheckTimeout ? parseInt(healthCheckTimeout, 10) : null;
      body.autoRollback = autoRollback;
      body.rollbackGracePeriod = rollbackGracePeriod ? parseInt(rollbackGracePeriod, 10) : 60;
      if (editParentId) {
        body.projectId = editParentId;
      } else {
        body.projectId = null;
      }

      // Detect whether any redeploy-required fields changed
      const redeployFieldChanged = (
        (body.deployType !== app.deployType) ||
        (body.gitBranch !== undefined && body.gitBranch !== (app.gitBranch || "")) ||
        (body.imageName !== undefined && body.imageName !== (app.imageName || "")) ||
        (body.containerPort !== app.containerPort) ||
        (body.restartPolicy !== (app.restartPolicy || "unless-stopped")) ||
        (body.rootDirectory !== (app.rootDirectory || null)) ||
        ((backendProtocol === "auto" ? null : backendProtocol) !== (app.backendProtocol ?? null))
      );

      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
        return;
      }

      onOpenChange(false);

      if (redeployFieldChanged) {
        toast.success("Saved — redeploy to apply changes", {
          action: {
            label: "Redeploy now",
            onClick: handleDeploy,
          },
          duration: 8000,
        });
      } else {
        toast.success("App updated");
      }

      router.refresh();
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent>
        <BottomSheetHeader>
          <BottomSheetTitle>Edit app</BottomSheetTitle>
          <BottomSheetDescription>
            Update app configuration.
          </BottomSheetDescription>
        </BottomSheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="grid gap-5 py-4">
            {/* Name + Description */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="edit-display-name">Display Name</Label>
                <Input
                  id="edit-display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-description">Description</Label>
                <Input
                  id="edit-description"
                  placeholder="Optional"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>

            {/* Image */}
            {app.deployType === "image" && (
              <div className="grid gap-2">
                <Label htmlFor="edit-image">Image</Label>
                <Input
                  id="edit-image"
                  placeholder="postgres:16"
                  value={editImageName}
                  onChange={(e) => setEditImageName(e.target.value)}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">Requires a redeploy to take effect.</p>
              </div>
            )}

            {/* Source settings */}
            {app.source === "git" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Branch</Label>
                  <BranchSelect
                    value={gitBranch}
                    onChange={setGitBranch}
                    appId={app.id}
                    orgId={orgId}
                  />
                  <p className="text-xs text-muted-foreground">Requires a redeploy to take effect.</p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-root-directory">Root Directory</Label>
                  <Input
                    id="edit-root-directory"
                    placeholder="./"
                    value={rootDirectory}
                    onChange={(e) => setRootDirectory(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Requires a redeploy to take effect.</p>
                </div>
              </div>
            )}

            {/* Deploy Type */}
            <div className="grid gap-4">
              <div className="grid gap-2 sm:w-1/2">
                <Label>Deploy Type</Label>
                <Select value={editDeployType} onValueChange={(v) => setEditDeployType(v as typeof editDeployType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="compose">Compose</SelectItem>
                    <SelectItem value="dockerfile">Dockerfile</SelectItem>
                    <SelectItem value="image">Image</SelectItem>
                    <SelectItem value="nixpacks">Nixpacks</SelectItem>
                    <SelectItem value="railpack">Railpack</SelectItem>
                    <SelectItem value="static">Static</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Requires a redeploy to take effect.</p>
              </div>
              {editDeployType === "compose" && (
                <div className="grid gap-2 sm:w-1/2">
                  <Label htmlFor="edit-compose-file-path">Compose File</Label>
                  <Input
                    id="edit-compose-file-path"
                    placeholder="docker-compose.yml"
                    value={editComposeFilePath}
                    onChange={(e) => setEditComposeFilePath(e.target.value)}
                    className="font-mono text-sm"
                  />
                </div>
              )}
              {editDeployType === "dockerfile" && (
                <div className="grid gap-2 sm:w-1/2">
                  <Label htmlFor="edit-dockerfile-path">Dockerfile</Label>
                  <Input
                    id="edit-dockerfile-path"
                    placeholder="Dockerfile"
                    value={editDockerfilePath}
                    onChange={(e) => setEditDockerfilePath(e.target.value)}
                    className="font-mono text-sm"
                  />
                </div>
              )}
            </div>

            {/* Port */}
            <div className="grid gap-2 sm:w-1/2">
              <Label>Container Port</Label>
              <div className="flex items-center gap-3">
                <Switch
                  id="edit-auto-port"
                  checked={autoPort}
                  onCheckedChange={(checked) => {
                    setAutoPort(checked);
                    if (checked) setContainerPort("");
                  }}
                />
                <Label htmlFor="edit-auto-port" className="text-sm font-normal text-muted-foreground">
                  Auto-detect
                </Label>
                {!autoPort && (
                  <Input
                    id="edit-container-port"
                    type="number"
                    placeholder="3000"
                    className="w-24"
                    value={containerPort}
                    onChange={(e) => setContainerPort(e.target.value)}
                  />
                )}
              </div>
              <p className="text-xs text-muted-foreground">Requires a redeploy to take effect.</p>
            </div>

            {/* Backend Protocol */}
            <div className="grid gap-2 sm:w-1/2">
              <Label>Backend Protocol</Label>
              <Select value={backendProtocol} onValueChange={(v) => setBackendProtocol(v as "auto" | "http" | "https")}>
                <SelectTrigger>
                  <SelectValue placeholder="Auto-detect" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-detect</SelectItem>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="https">HTTPS</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Protocol Traefik uses to reach the container. Auto-detect defaults to HTTPS when port is 443 or 8443. Use HTTPS for apps like Kasm that serve TLS internally.
              </p>
              <p className="text-xs text-muted-foreground">Requires a redeploy to take effect.</p>
            </div>

            {/* Restart policy */}
            <div className="grid gap-2 sm:w-1/2">
              <Label>Restart Policy</Label>
              <Select value={restartPolicy} onValueChange={setRestartPolicy}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unless-stopped">Unless Stopped</SelectItem>
                  <SelectItem value="always">Always</SelectItem>
                  <SelectItem value="on-failure">On Failure</SelectItem>
                  <SelectItem value="no">Never</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Requires a redeploy to take effect.</p>
            </div>

            {/* Resource Limits */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="edit-cpu-limit">CPU Limit (cores)</Label>
                <Input id="edit-cpu-limit" type="number" step="0.1" min="0.1" placeholder="No limit" value={cpuLimit} onChange={(e) => setCpuLimit(e.target.value)} />
                <p className="text-xs text-muted-foreground">{cpuLimit ? cpuLimit + " CPU core(s)" : "No limit"}</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-memory-limit">Memory Limit (MB)</Label>
                <Input id="edit-memory-limit" type="number" step="64" min="64" placeholder="No limit" value={memoryLimit} onChange={(e) => setMemoryLimit(e.target.value)} />
                <p className="text-xs text-muted-foreground">{memoryLimit ? memoryLimit + " MB" : "No limit"}</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-disk-write-threshold">Disk Write Alert (GB/hr)</Label>
                <Input id="edit-disk-write-threshold" type="number" step="0.5" min="0.1" placeholder="Default: 1 GB" value={diskWriteAlertThreshold} onChange={(e) => setDiskWriteAlertThreshold(e.target.value)} />
                <p className="text-xs text-muted-foreground">{diskWriteAlertThreshold ? diskWriteAlertThreshold + " GB/hr" : "Default: 1 GB/hr"}</p>
              </div>
            </div>

            {/* Health Check Timeout */}
            <div className="grid gap-2 sm:w-1/2">
              <Label htmlFor="edit-health-timeout">Health Check Timeout (seconds)</Label>
              <Input
                id="edit-health-timeout"
                type="number"
                step="10"
                min="10"
                max="600"
                placeholder="60"
                value={healthCheckTimeout}
                onChange={(e) => setHealthCheckTimeout(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                How long to wait for all containers to be healthy after deploy. Increase for services with slow startup like VPN tunnels.
              </p>
            </div>

            {/* Toggles */}
            <div className="grid gap-3">
              <div className="flex items-center gap-3">
                <Switch
                  id="edit-auto-deploy"
                  checked={autoDeploy}
                  onCheckedChange={setAutoDeploy}
                />
                <Label htmlFor="edit-auto-deploy">Auto Deploy</Label>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  id="edit-auto-rollback"
                  checked={autoRollback}
                  onCheckedChange={setAutoRollback}
                />
                <Label htmlFor="edit-auto-rollback">Auto Rollback</Label>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  id="edit-gpu-enabled"
                  checked={gpuEnabled}
                  onCheckedChange={setGpuEnabled}
                  disabled={userRole !== "owner" && userRole !== "admin"}
                />
                <div className="grid gap-0.5">
                  <Label htmlFor="edit-gpu-enabled">GPU Access</Label>
                  <p className="text-xs text-muted-foreground">
                    {userRole === "owner" || userRole === "admin"
                      ? <>Pass all NVIDIA GPUs through to the container via <span className="font-mono">deploy.resources.reservations.devices</span>. Requires the NVIDIA Container Toolkit on the host.</>
                      : "Only owners and admins can enable GPU access."}
                  </p>
                </div>
              </div>
              {autoRollback && (
                <div className="grid gap-2 pl-10">
                  <Label htmlFor="edit-rollback-grace">Grace Period (seconds)</Label>
                  <Input
                    id="edit-rollback-grace"
                    type="number"
                    step="10"
                    min="10"
                    max="600"
                    value={rollbackGracePeriod}
                    onChange={(e) => setRollbackGracePeriod(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Monitor for container crashes for this duration after deploy. If a crash is detected, automatically roll back to the previous version.
                  </p>
                </div>
              )}
            </div>

            {/* Project */}
            <div className="grid gap-2">
              <Label>Project</Label>
              <Select
                value={editParentId ?? ""}
                onValueChange={setEditParentId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {allParentApps.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="flex items-center gap-2">
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: p.color }}
                        />
                        {p.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Group this app under a project for organization.
              </p>
            </div>
          </div>
        </div>

        <BottomSheetFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !displayName.trim()}
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </BottomSheetFooter>
      </BottomSheetContent>
    </BottomSheet>
  );
}
