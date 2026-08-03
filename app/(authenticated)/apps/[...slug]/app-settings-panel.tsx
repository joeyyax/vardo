"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock } from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BranchSelect } from "@/components/branch-select";
import { systemManagedRefusal } from "@/lib/api/system-managed";
import {
  appSettingsPageFields,
  APP_SETTINGS_REDEPLOY_KEYS,
  type AppSettingsPage,
} from "@/lib/ui/app-settings-fields";

import type { App } from "./types";

/** Said under every field the container only picks up when it is recreated. */
const REDEPLOY_NOTE = "Requires a redeploy to take effect.";

/**
 * The app's settings fields, one page of them at a time. The only writer of
 * these fields — a page is a subset of the same form, never a copy of it.
 */
export function AppSettingsPanel({
  app,
  orgId,
  userRole,
  allParentApps,
  handleDeploy,
  isComposeParent = false,
  page = "settings",
}: {
  app: App;
  orgId: string;
  userRole: string;
  allParentApps: { id: string; name: string; color: string }[];
  handleDeploy: () => void;
  /** Renders the stack's settings: no per-container fields, stack-wide wording. */
  isComposeParent?: boolean;
  /** Which section rail entry this instance is rendering. */
  page?: AppSettingsPage;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  // Vardo rewrites these rows on every boot, and the API refuses the PATCH, so
  // the fields are shown as a record rather than offered as an editor.
  const refusal = systemManagedRefusal(app, "edit");
  const locked = refusal !== null;

  // Decomposed compose service: build/deploy/networking are controlled by the
  // parent compose app, so those settings are hidden here. Per-service config
  // (resources, GPU, priority, health) stays editable. (#745)
  const isChildService = !!app.parentAppId;

  // Edit form state
  const [displayName, setDisplayName] = useState(app.displayName);
  const [description, setDescription] = useState(app.description || "");
  const [containerPort, setContainerPort] = useState(
    app.containerPort?.toString() || ""
  );
  const [autoPort, setAutoPort] = useState(!app.containerPort);
  const [editImageName, setEditImageName] = useState(app.imageName || "");
  const [restartPolicy, setRestartPolicy] = useState(app.restartPolicy || "unless-stopped");
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
  // A decomposed child can inherit the parent's tier (priority === null → the
  // "inherit" sentinel here). Non-child apps always have a concrete tier.
  const [priority, setPriority] = useState<"critical" | "standard" | "disposable" | "inherit">(
    isChildService ? (app.priority ?? "inherit") : (app.priority ?? "standard"),
  );
  const [backendProtocol, setBackendProtocol] = useState<"auto" | "http" | "https">(app.backendProtocol || "auto");
  const [diskWriteAlertThreshold, setDiskWriteAlertThreshold] = useState(app.diskWriteAlertThreshold ? (app.diskWriteAlertThreshold / 1_073_741_824).toString() : "");
  const [healthCheckTimeout, setHealthCheckTimeout] = useState(app.healthCheckTimeout?.toString() || "60");
  const [autoRollback, setAutoRollback] = useState(app.autoRollback ?? false);
  const [rollbackGracePeriod, setRollbackGracePeriod] = useState(app.rollbackGracePeriod?.toString() || "60");

  const fields = appSettingsPageFields(page, {
    isComposeParent,
    isChildService,
    deployType: editDeployType,
    storedDeployType: app.deployType,
    source: app.source,
  });

  const canUseGpu = userRole === "owner" || userRole === "admin";

  async function handleSave() {
    setSaving(true);
    try {
      // Only fields the panel showed are written — a hidden one would send back
      // whatever it was seeded with, and each page hides the other pages'.
      const body: Record<string, unknown> = {};
      if (fields.identity) {
        body.displayName = displayName.trim();
        body.description = description.trim() || null;
      }
      if (fields.restartPolicy) body.restartPolicy = restartPolicy;
      if (fields.resourceLimits) {
        body.cpuLimit = cpuLimit ? parseFloat(cpuLimit) : null;
        body.memoryLimit = memoryLimit ? parseInt(memoryLimit, 10) : null;
      }
      if (fields.priority) body.priority = priority === "inherit" ? null : priority;
      if (fields.gpu) body.gpuEnabled = gpuEnabled;
      if (fields.healthCheckTimeout) {
        body.healthCheckTimeout = healthCheckTimeout ? parseInt(healthCheckTimeout, 10) : null;
      }
      if (fields.project) body.projectId = editParentId || null;
      if (fields.containerPort) {
        body.containerPort = containerPort ? parseInt(containerPort, 10) : null;
      }
      if (fields.deployType) body.deployType = editDeployType;
      if (fields.composeFilePath) {
        body.composeFilePath = editComposeFilePath || "docker-compose.yml";
      }
      if (fields.dockerfilePath) {
        body.dockerfilePath = editDockerfilePath || "Dockerfile";
      }
      if (fields.gitSource) {
        body.gitBranch = gitBranch;
        body.rootDirectory = rootDirectory.trim() || null;
      }
      if (fields.image && editImageName.trim()) body.imageName = editImageName.trim();
      if (fields.backendProtocol) {
        body.backendProtocol = backendProtocol === "auto" ? null : backendProtocol;
      }
      if (fields.diskWriteAlert) {
        body.diskWriteAlertThreshold = diskWriteAlertThreshold
          ? Math.round(parseFloat(diskWriteAlertThreshold) * 1_073_741_824)
          : null;
      }
      if (fields.autoDeploy) body.autoDeploy = autoDeploy;
      if (fields.autoRollback) {
        body.autoRollback = autoRollback;
        body.rollbackGracePeriod = rollbackGracePeriod ? parseInt(rollbackGracePeriod, 10) : 60;
      }

      // Resource limits, GPU and priority reach the container through the
      // compose overlay, so they only apply when it is recreated.
      const stored: Record<string, unknown> = {
        deployType: app.deployType,
        gitBranch: app.gitBranch || "",
        imageName: app.imageName || "",
        rootDirectory: app.rootDirectory || null,
        containerPort: app.containerPort,
        backendProtocol: app.backendProtocol ?? null,
        restartPolicy: app.restartPolicy || "unless-stopped",
        cpuLimit: app.cpuLimit,
        memoryLimit: app.memoryLimit,
        priority: app.priority,
        gpuEnabled: app.gpuEnabled ?? false,
      };
      const redeployFieldChanged = APP_SETTINGS_REDEPLOY_KEYS.some(
        (key) => key in body && body[key] !== stored[key],
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
    <fieldset disabled={locked} className="grid min-w-0 gap-5">
      {refusal && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Lock className="mt-0.5 size-4 shrink-0" />
          {refusal}
        </p>
      )}

      {/* Resources is nearly all redeploy-required, so the page says it once
          instead of repeating it under five fields. */}
      {page === "resources" && (
        <p className="text-sm text-muted-foreground">
          Restart policy, limits, priority and GPU are written into the compose
          overlay — save here, then redeploy. The alert threshold and health check
          timeout apply on save.
        </p>
      )}

      {/* Name + Description */}
      {fields.identity && (
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
      )}

      {/* A child service hides what its parent stack controls (#745); a compose
          parent hides what only a single container has (#87). */}

      {/* Image */}
      {fields.image && (
        <div className="grid gap-2">
          <Label htmlFor="edit-image">Image</Label>
          <Input
            id="edit-image"
            placeholder="postgres:16"
            value={editImageName}
            onChange={(e) => setEditImageName(e.target.value)}
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">{REDEPLOY_NOTE}</p>
        </div>
      )}

      {/* Source settings */}
      {fields.gitSource && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Branch</Label>
            <BranchSelect
              value={gitBranch}
              onChange={setGitBranch}
              appId={app.id}
              orgId={orgId}
            />
            <p className="text-xs text-muted-foreground">{REDEPLOY_NOTE}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="edit-root-directory">Root Directory</Label>
            <Input
              id="edit-root-directory"
              placeholder="./"
              value={rootDirectory}
              onChange={(e) => setRootDirectory(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{REDEPLOY_NOTE}</p>
          </div>
        </div>
      )}

      {/* Deploy Type */}
      {(fields.deployType || fields.composeFilePath || fields.dockerfilePath) && (
        <div className="grid gap-4">
          {fields.deployType && (
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
              <p className="text-xs text-muted-foreground">{REDEPLOY_NOTE}</p>
            </div>
          )}
          {fields.composeFilePath && (
            <div className="grid gap-2 sm:w-1/2">
              <Label htmlFor="edit-compose-file-path">Compose File</Label>
              <Input
                id="edit-compose-file-path"
                placeholder="docker-compose.yml"
                value={editComposeFilePath}
                onChange={(e) => setEditComposeFilePath(e.target.value)}
                className="font-mono text-sm"
              />
              {isComposeParent && (
                <p className="text-xs text-muted-foreground">
                  File the stack&apos;s services are read from. {REDEPLOY_NOTE}
                </p>
              )}
            </div>
          )}
          {fields.dockerfilePath && (
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
      )}

      {/* Port */}
      {fields.containerPort && (
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
          {isComposeParent && (
            <p className="text-xs text-muted-foreground">
              Port a domain routes to when it names none, which also picks the service that serves it.
            </p>
          )}
          <p className="text-xs text-muted-foreground">{REDEPLOY_NOTE}</p>
        </div>
      )}

      {/* Backend Protocol */}
      {fields.backendProtocol && (
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
            Protocol Traefik uses to reach {isComposeParent ? "a routed service" : "the container"}. Auto-detect defaults to HTTPS when port is 443 or 8443. Use HTTPS for apps like Kasm that serve TLS internally.
          </p>
          <p className="text-xs text-muted-foreground">{REDEPLOY_NOTE}</p>
        </div>
      )}

      {/* Restart policy */}
      {fields.restartPolicy && (
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
        </div>
      )}

      {/* Resource Limits */}
      {fields.resourceLimits && (
        <div className="grid gap-2">
          <div className={fields.diskWriteAlert ? "grid gap-4 sm:grid-cols-3" : "grid gap-4 sm:grid-cols-2"}>
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
            {fields.diskWriteAlert && (
              <div className="grid gap-2">
                <Label htmlFor="edit-disk-write-threshold">Disk Write Alert (GB/hr)</Label>
                <Input id="edit-disk-write-threshold" type="number" step="0.5" min="0.1" placeholder="Default: 1 GB" value={diskWriteAlertThreshold} onChange={(e) => setDiskWriteAlertThreshold(e.target.value)} />
                <p className="text-xs text-muted-foreground">{diskWriteAlertThreshold ? diskWriteAlertThreshold + " GB/hr" : "Default: 1 GB/hr"}</p>
              </div>
            )}
          </div>
          {isComposeParent && (
            <p className="text-xs text-muted-foreground">
              Each service gets these limits, unless it sets its own in Services.
            </p>
          )}
        </div>
      )}

      {/* Priority (QoS tier) */}
      {fields.priority && (
        <div className="grid gap-2 sm:w-1/2">
          <Label htmlFor="edit-priority">Priority</Label>
          <Select value={priority} onValueChange={(v) => setPriority(v as "critical" | "standard" | "disposable" | "inherit")}>
            <SelectTrigger id="edit-priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fields.priorityInherit && <SelectItem value="inherit">Inherit (parent)</SelectItem>}
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="standard">Standard</SelectItem>
              <SelectItem value="disposable">Disposable</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {priority === "inherit"
              ? "Uses the parent stack's priority for this service."
              : priority === "critical"
                ? "Protected from the OOM killer and given the largest CPU share. Requires a memory limit."
                : priority === "disposable"
                  ? "Killed first under memory pressure and given the smallest CPU share."
                  : "Default eviction priority and CPU share."}
          </p>
          {isComposeParent && (
            <p className="text-xs text-muted-foreground">
              Every service inherits this tier, unless it sets its own in Services.
            </p>
          )}
        </div>
      )}

      {/* Health Check Timeout */}
      {fields.healthCheckTimeout && (
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
      )}

      {/* Toggles */}
      {(fields.autoDeploy || fields.autoRollback || fields.gpu) && (
        <div className="grid gap-3">
          {fields.autoDeploy && (
            <div className="flex items-center gap-3">
              <Switch
                id="edit-auto-deploy"
                checked={autoDeploy}
                onCheckedChange={setAutoDeploy}
              />
              <Label htmlFor="edit-auto-deploy">Auto Deploy</Label>
            </div>
          )}
          {fields.autoRollback && (
            <div className="flex items-center gap-3">
              <Switch
                id="edit-auto-rollback"
                checked={autoRollback}
                onCheckedChange={setAutoRollback}
              />
              <Label htmlFor="edit-auto-rollback">Auto Rollback</Label>
            </div>
          )}
          {fields.gpu && (
            <div className="flex items-center gap-3">
              <Switch
                id="edit-gpu-enabled"
                checked={gpuEnabled}
                onCheckedChange={setGpuEnabled}
                disabled={!canUseGpu}
              />
              <div className="grid gap-0.5">
                <Label htmlFor="edit-gpu-enabled">GPU Access</Label>
                <p className="text-xs text-muted-foreground">
                  {canUseGpu
                    ? <>Pass all NVIDIA GPUs through to {isComposeParent ? "every service that has no named volume" : "the container"} via <span className="font-mono">deploy.resources.reservations.devices</span>. Requires the NVIDIA Container Toolkit on the host.</>
                    : "Only owners and admins can enable GPU access."}
                </p>
              </div>
            </div>
          )}
          {fields.autoRollback && autoRollback && (
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
      )}

      {/* Project */}
      {fields.project && (
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
      )}

      {!locked && (
        <div className="flex justify-end border-t pt-4">
          <Button onClick={handleSave} disabled={saving || (fields.identity && !displayName.trim())}>
            {saving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </div>
      )}
    </fieldset>
  );
}
