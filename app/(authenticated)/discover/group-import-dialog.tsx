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
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DiscoveredContainer } from "@/lib/docker/discover";
import { slugify } from "@/lib/ui/slugify";

type Project = { id: string; name: string; displayName: string };

type GroupImportDialogProps = {
  group: { composeProject: string; containers: DiscoveredContainer[] } | null;
  orgId: string;
  projects: Project[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultProjectId?: string;
};

export function GroupImportDialog({
  group,
  orgId,
  projects,
  open,
  onOpenChange,
  defaultProjectId,
}: GroupImportDialogProps) {
  const router = useRouter();

  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState<string>("none");
  const [newProjectName, setNewProjectName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !group) return;

    const initial = group.composeProject;
    setDisplayName(initial);
    setName(slugify(initial));
    const validDefault = defaultProjectId && projects.some((p) => p.id === defaultProjectId);
    setProjectId(validDefault ? defaultProjectId : "none");
    setNewProjectName("");
  }, [open, group, defaultProjectId, projects]);

  async function handleSubmit() {
    if (!group) return;

    setSubmitting(true);
    try {
      const body = {
        displayName,
        name,
        projectId: projectId === "none" ? null : projectId === "new" ? null : projectId,
        newProjectName: projectId === "new" ? newProjectName : undefined,
      };

      const res = await fetch(
        `/api/v1/organizations/${orgId}/discover/groups/${encodeURIComponent(group.composeProject)}/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 409 && data.appId) {
          toast.error("Stack already imported", {
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

  const canSubmit =
    !submitting && !!name && !!displayName && (projectId !== "new" || !!newProjectName);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import compose stack</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-1">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="group-displayName">Display name</Label>
              <Input
                id="group-displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="My Stack"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="group-name">Slug</Label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-stack"
                className="font-mono text-sm"
                aria-describedby="group-slug-hint"
              />
              <p id="group-slug-hint" className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and hyphens only.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="group-project">Project</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="group-project">
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
              <Label htmlFor="group-newProjectName">New project name</Label>
              <Input
                id="group-newProjectName"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="My Project"
              />
            </div>
          )}

          {group && group.containers.length > 0 && (
            <div className="space-y-1.5">
              <Label>Services</Label>
              <div className="flex flex-wrap gap-1.5">
                {group.containers.map((c) => (
                  <Badge key={c.id} variant="secondary" className="font-mono text-xs">
                    {c.name}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                All {group.containers.length} service{group.containers.length !== 1 ? "s" : ""} will
                be imported together as a single compose project. Each service gets its own app
                record in the UI.
              </p>
            </div>
          )}

          <p className="text-xs text-muted-foreground border-t pt-4">
            Importing creates a Vardo app from this stack&apos;s configuration. The containers
            continue running — future deploys will be managed by Vardo.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? "Importing..." : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
