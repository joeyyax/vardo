"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/messenger";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, X, HardDrive, FolderOpen } from "lucide-react";
import type { DiscoveredContainer, ContainerDetail } from "@/lib/docker/discover";
import { slugify } from "@/lib/ui/slugify";

type Project = { id: string; name: string; displayName: string };

type EnvVar = { key: string; value: string };

type ImportDialogProps = {
  container: DiscoveredContainer | null;
  orgId: string;
  projects: Project[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultProjectId?: string;
};

export function ImportDialog({
  container,
  orgId,
  projects,
  open,
  onOpenChange,
  defaultProjectId,
}: ImportDialogProps) {
  const router = useRouter();

  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [newProjectName, setNewProjectName] = useState("");
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  // Per-mount toggles: keyed by destination path
  const [mountToggles, setMountToggles] = useState<Record<string, boolean>>({});
  const [containerPort, setContainerPort] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  // Load container detail when dialog opens
  useEffect(() => {
    if (!open || !container) return;

    const initialName = slugify(container.name);
    setDisplayName(container.name);
    setName(initialName);
    const validDefault = defaultProjectId && projects.some((p) => p.id === defaultProjectId);
    setProjectId(validDefault ? defaultProjectId : "");
    setNewProjectName("");
    setEnvVars([]);
    setMountToggles({});
    setContainerPort("");
    setDetail(null);
    setDetailError(false);

    setLoadingDetail(true);
    const controller = new AbortController();

    fetch(`/api/v1/organizations/${orgId}/discover/containers/${container.id}`, {
      signal: controller.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error("Failed to fetch container details");
        return r.json();
      })
      .then((d: ContainerDetail) => {
        setDetail(d);
        // Pre-fill env vars from container inspect
        const parsed: EnvVar[] = (d.env ?? [])
          .map((line) => {
            const idx = line.indexOf("=");
            if (idx === -1) return null;
            return { key: line.slice(0, idx), value: line.slice(idx + 1) };
          })
          .filter((v): v is EnvVar => v !== null);
        setEnvVars(parsed);
        // Default all mounts to selected
        const toggles: Record<string, boolean> = {};
        for (const m of d.mounts) {
          toggles[m.destination] = true;
        }
        setMountToggles(toggles);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setDetailError(true);
        toast.error("Failed to load container details");
      })
      .finally(() => setLoadingDetail(false));

    return () => controller.abort();
  }, [open, container, orgId, defaultProjectId, projects]);

  function removeEnvVar(index: number) {
    setEnvVars((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleMount(destination: string, checked: boolean) {
    setMountToggles((prev) => ({ ...prev, [destination]: checked }));
  }

  const setAllMounts = useCallback(
    (checked: boolean) => {
      if (!detail) return;
      const toggles: Record<string, boolean> = {};
      for (const m of detail.mounts) {
        toggles[m.destination] = checked;
      }
      setMountToggles(toggles);
    },
    [detail]
  );

  async function handleSubmit() {
    if (!container) return;

    setSubmitting(true);
    try {
      const selectedMountDestinations = (detail?.mounts ?? [])
        .filter((m) => mountToggles[m.destination])
        .map((m) => m.destination);

      const portOverride =
        !portAutoDetected && containerPort !== ""
          ? parseInt(containerPort, 10)
          : undefined;

      const body = {
        displayName,
        name,
        projectId: projectId === "new" ? undefined : projectId || undefined,
        newProjectName: projectId === "new" ? newProjectName : undefined,
        envVars,
        selectedMountDestinations,
        containerPort: portOverride,
      };

      const res = await fetch(
        `/api/v1/organizations/${orgId}/discover/containers/${container.id}/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 409 && data.appId) {
          toast.error("Container already imported", {
            description: "Redirecting to the existing app.",
          });
          router.push(`/apps/${data.appId}`);
          onOpenChange(false);
          return;
        }
        toast.error(data.error ?? "Import failed");
        return;
      }

      if (data.warnings?.length > 0) {
        for (const warning of data.warnings) {
          toast.warning(warning);
        }
      }

      toast.success(`${displayName} imported successfully`);
      onOpenChange(false);
      router.push(`/apps/${data.app.id}`);
    } catch {
      toast.error("Import failed — network error");
    } finally {
      setSubmitting(false);
    }
  }

  const mounts = detail?.mounts ?? [];
  const selectedMounts = mounts.filter((m) => mountToggles[m.destination]);
  const hasSelectedBindMounts = selectedMounts.some((m) => m.type === "bind");
  const selectedCount = selectedMounts.length;
  const isHostNetwork = (detail?.networkMode ?? container?.networkMode) === "host";

  // Port auto-detection fails when there's no Traefik label and no exposed ports.
  // Only relevant for non-host-network containers since host networking has no port routing.
  const portAutoDetected =
    !detail ||
    isHostNetwork ||
    detail.containerPort !== null ||
    detail.ports.some((p) => p.internal);
  const portFieldValid = portAutoDetected || (containerPort !== "" && /^\d+$/.test(containerPort) && parseInt(containerPort, 10) > 0 && parseInt(containerPort, 10) <= 65535);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import container</DialogTitle>
        </DialogHeader>

        {loadingDetail ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Loading container details...
          </div>
        ) : detailError ? (
          <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            Failed to load container details. Close and try again.
          </div>
        ) : (
          <div className="space-y-5 py-1">
            {isHostNetwork && (
              <div role="alert" className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                <AlertTriangle aria-hidden="true" className="size-4 shrink-0 mt-0.5" />
                <span>
                  This container uses host networking — no port mapping or automatic domain
                  routing is available.
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="displayName">Display name</Label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="My App"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="name">Slug</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-app"
                  className="font-mono text-sm"
                  aria-describedby="slug-hint"
                />
                <p id="slug-hint" className="text-xs text-muted-foreground">Lowercase letters, numbers, and hyphens only.</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project">Project <span className="text-destructive">*</span></Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="project">
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">Create new project...</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!portAutoDetected && (
              <div className="space-y-1.5">
                <Label htmlFor="containerPort">Container port</Label>
                <Input
                  id="containerPort"
                  type="number"
                  min={1}
                  max={65535}
                  value={containerPort}
                  onChange={(e) => setContainerPort(e.target.value)}
                  placeholder="e.g. 3000"
                />
                <p className="text-xs text-muted-foreground">
                  Port could not be detected automatically. Enter the port your container listens on for HTTP traffic.
                </p>
              </div>
            )}

            {projectId === "new" && (
              <div className="space-y-1.5">
                <Label htmlFor="newProjectName">New project name</Label>
                <Input
                  id="newProjectName"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="My Project"
                />
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Environment variables</Label>
                <span className="text-xs text-muted-foreground">
                  {envVars.length} var{envVars.length !== 1 ? "s" : ""}
                </span>
              </div>
              {envVars.length === 0 && !loadingDetail && (
                <p className="text-xs text-muted-foreground">No environment variables found.</p>
              )}
              {envVars.length > 0 && (
                <div className="max-h-48 overflow-y-auto space-y-1.5 rounded-lg border p-2">
                  {envVars.map((v, i) => (
                    <div key={`${v.key}-${i}`} className="flex items-center gap-2 text-xs font-mono">
                      <span className="text-muted-foreground min-w-0 flex-1 truncate">
                        {v.key}
                      </span>
                      <Badge variant="outline" className="font-mono text-xs truncate max-w-32">
                        {v.value.length > 20 ? `${v.value.slice(0, 20)}…` : v.value}
                      </Badge>
                      <button
                        type="button"
                        onClick={() => removeEnvVar(i)}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={`Remove ${v.key}`}
                      >
                        <X aria-hidden="true" className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {mounts.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Mounts</Label>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{selectedCount} of {mounts.length} selected</span>
                    <button
                      type="button"
                      onClick={() => setAllMounts(true)}
                      className="px-2 py-1 hover:text-foreground transition-colors"
                    >
                      All
                    </button>
                    <span aria-hidden="true">/</span>
                    <button
                      type="button"
                      onClick={() => setAllMounts(false)}
                      className="px-2 py-1 hover:text-foreground transition-colors"
                    >
                      None
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5 rounded-lg border p-2">
                  {mounts.map((m) => {
                    const isBind = m.type === "bind";
                    const isSelected = mountToggles[m.destination] ?? true;
                    return (
                      <div
                        key={m.destination}
                        className="flex items-start gap-2.5 rounded-md px-1 py-1.5"
                      >
                        <Checkbox
                          id={`mount-${m.destination}`}
                          checked={isSelected}
                          onCheckedChange={(checked) => toggleMount(m.destination, !!checked)}
                          className="mt-0.5 shrink-0"
                        />
                        <Label
                          htmlFor={`mount-${m.destination}`}
                          className="min-w-0 flex-1 cursor-pointer space-y-0.5 font-normal"
                        >
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {isBind ? (
                              <FolderOpen aria-hidden="true" className="size-3 shrink-0 text-amber-500" />
                            ) : (
                              <HardDrive aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                            )}
                            <span className="font-mono text-xs truncate">
                              {m.destination}
                            </span>
                            {isBind ? (
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 h-4 border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400 shrink-0"
                              >
                                bind
                              </Badge>
                            ) : (
                              <Badge
                                variant="secondary"
                                className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                              >
                                named
                              </Badge>
                            )}
                          </div>
                          {isBind ? (
                            <p className="text-[10px] text-amber-600 dark:text-amber-500 font-mono truncate pl-4">
                              Host: {m.source}
                            </p>
                          ) : (
                            <p className="text-[10px] text-muted-foreground font-mono truncate pl-4">
                              Volume: {m.source}
                            </p>
                          )}
                        </Label>
                      </div>
                    );
                  })}
                </div>

                {hasSelectedBindMounts && (
                  <div role="alert" className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 mt-0.5" />
                    <span>
                      Bind mounts reference host paths — they&apos;ll be included in the generated
                      compose file but Vardo won&apos;t manage the data.
                    </span>
                  </div>
                )}
              </div>
            )}

            <p className="text-xs text-muted-foreground border-t pt-4">
              Importing creates a Vardo app record from this container&apos;s configuration. The
              container continues running — future deploys will be managed by Vardo.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || loadingDetail || detailError || !name || !displayName || !portFieldValid || (!projectId || (projectId === "new" && !newProjectName))}
          >
            {submitting ? "Importing..." : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
