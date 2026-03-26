"use client";

import { useState, useEffect } from "react";
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
import { AlertTriangle, X } from "lucide-react";
import type { DiscoveredContainer, ContainerDetail } from "@/lib/docker/discover";

type Project = { id: string; name: string; displayName: string };

type EnvVar = { key: string; value: string };

type ImportDialogProps = {
  container: DiscoveredContainer | null;
  orgId: string;
  projects: Project[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function ImportDialog({
  container,
  orgId,
  projects,
  open,
  onOpenChange,
}: ImportDialogProps) {
  const router = useRouter();

  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState<string>("none");
  const [newProjectName, setNewProjectName] = useState("");
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [importVolumes, setImportVolumes] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Load container detail when dialog opens
  useEffect(() => {
    if (!open || !container) return;

    const initialName = slugify(container.name);
    setDisplayName(container.name);
    setName(initialName);
    setProjectId("none");
    setNewProjectName("");
    setEnvVars([]);
    setImportVolumes(true);
    setDetail(null);

    setLoadingDetail(true);
    const controller = new AbortController();

    fetch(`/api/v1/organizations/${orgId}/discover/containers/${container.id}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
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
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        toast.error("Failed to load container details");
      })
      .finally(() => setLoadingDetail(false));

    return () => controller.abort();
  }, [open, container, orgId]);

  function removeEnvVar(key: string) {
    setEnvVars((prev) => prev.filter((v) => v.key !== key));
  }

  async function handleSubmit() {
    if (!container) return;

    setSubmitting(true);
    try {
      const body = {
        displayName,
        name,
        projectId: projectId === "none" ? null : projectId === "new" ? null : projectId,
        newProjectName: projectId === "new" ? newProjectName : undefined,
        envVars,
        importVolumes,
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

  const hasBindMounts = (detail?.mounts ?? []).some((m) => m.type === "bind");
  const isHostNetwork = (detail?.networkMode ?? container?.networkMode) === "host";

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
        ) : (
          <div className="space-y-5 py-1">
            {isHostNetwork && (
              <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
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
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project">Project</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="project">
                  <SelectValue placeholder="No project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No project</SelectItem>
                  <SelectItem value="new">Create new project...</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

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
                  {envVars.map((v) => (
                    <div key={v.key} className="flex items-center gap-2 text-xs font-mono">
                      <span className="text-muted-foreground min-w-0 flex-1 truncate">
                        {v.key}
                      </span>
                      <Badge variant="outline" className="font-mono text-xs truncate max-w-32">
                        {v.value.length > 20 ? `${v.value.slice(0, 20)}…` : v.value}
                      </Badge>
                      <button
                        type="button"
                        onClick={() => removeEnvVar(v.key)}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={`Remove ${v.key}`}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {(detail?.mounts?.length ?? 0) > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="importVolumes"
                    checked={importVolumes}
                    onCheckedChange={(checked) => setImportVolumes(!!checked)}
                  />
                  <Label htmlFor="importVolumes" className="cursor-pointer">
                    Import volume references ({detail?.mounts.length ?? 0})
                  </Label>
                </div>
                {importVolumes && hasBindMounts && (
                  <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
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
            disabled={submitting || loadingDetail || !name || !displayName}
          >
            {submitting ? "Importing..." : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
