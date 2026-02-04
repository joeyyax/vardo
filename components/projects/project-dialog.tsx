"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Archive, ArchiveRestore } from "lucide-react";
import { ProjectTasks } from "./project-tasks";

export type Client = {
  id: string;
  name: string;
  color: string | null;
};

export type Project = {
  id: string;
  clientId: string;
  name: string;
  code: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  client: Client;
};

type ProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Project | null;
  orgId: string;
  clients: Client[];
  defaultClientId?: string | null;
  onSuccess: () => void;
};

export function ProjectDialog({
  open,
  onOpenChange,
  project,
  orgId,
  clients,
  defaultClientId,
  onSuccess,
}: ProjectDialogProps) {
  const isEditing = !!project;

  // Form state
  const [clientId, setClientId] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [rateOverride, setRateOverride] = useState("");
  const [isBillable, setIsBillable] = useState<boolean | null>(null);

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens/closes or project changes
  useEffect(() => {
    if (open) {
      if (project) {
        setClientId(project.clientId);
        setName(project.name);
        setCode(project.code || "");
        // Convert cents to dollars for display
        setRateOverride(
          project.rateOverride !== null
            ? (project.rateOverride / 100).toString()
            : ""
        );
        setIsBillable(project.isBillable);
      } else {
        // New project - use default client if provided
        setClientId(defaultClientId || "");
        setName("");
        setCode("");
        setRateOverride("");
        setIsBillable(null);
      }
      setError(null);
    }
  }, [open, project, defaultClientId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const payload = {
        clientId,
        name,
        code: code || null,
        rateOverride: rateOverride !== "" ? parseFloat(rateOverride) : null,
        isBillable,
      };

      const url = isEditing
        ? `/api/v1/organizations/${orgId}/projects/${project.id}`
        : `/api/v1/organizations/${orgId}/projects`;

      const response = await fetch(url, {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  };

  const handleArchive = async () => {
    if (!project) return;

    setIsArchiving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isArchived: !project.isArchived }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsArchiving(false);
    }
  };

  const handleDelete = async () => {
    if (!project) return;

    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsDeleting(false);
    }
  };

  const isDisabled = isLoading || isDeleting || isArchiving;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`squircle ${isEditing ? "sm:max-w-xl" : "sm:max-w-md"}`}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {isEditing ? "Edit project" : "New project"}
            </DialogTitle>
            <DialogDescription>
              {isEditing
                ? "Update your project details."
                : "Add a new project to organize your work."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 py-6">
            {/* Client selector */}
            <div className="grid gap-2">
              <Label htmlFor="client">Client</Label>
              <Select
                value={clientId}
                onValueChange={setClientId}
                disabled={isDisabled}
              >
                <SelectTrigger className="squircle">
                  <SelectValue placeholder="Select a client" />
                </SelectTrigger>
                <SelectContent className="squircle">
                  {clients.map((client) => (
                    <SelectItem key={client.id} value={client.id}>
                      <div className="flex items-center gap-2">
                        <div
                          className="size-2.5 shrink-0 rounded-full ring-1 ring-border"
                          style={{
                            backgroundColor: client.color || "#94a3b8",
                          }}
                        />
                        <span>{client.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {clients.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  You need to create a client first.
                </p>
              )}
            </div>

            {/* Name */}
            <div className="grid gap-2">
              <Label htmlFor="name">Project name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Website redesign"
                required
                disabled={isDisabled}
                className="squircle"
              />
            </div>

            {/* Code */}
            <div className="grid gap-2">
              <Label htmlFor="code">Project code</Label>
              <p className="text-sm text-muted-foreground">
                Optional short code for quick reference.
              </p>
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ACME-001"
                disabled={isDisabled}
                className="squircle"
              />
            </div>

            {/* Hourly rate override */}
            <div className="grid gap-2">
              <Label htmlFor="rate">Hourly rate override</Label>
              <p className="text-sm text-muted-foreground">
                Leave blank to inherit from client.
              </p>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  id="rate"
                  type="number"
                  min="0"
                  step="0.01"
                  value={rateOverride}
                  onChange={(e) => setRateOverride(e.target.value)}
                  placeholder="0.00"
                  disabled={isDisabled}
                  className="squircle pl-7"
                />
              </div>
            </div>

            {/* Billable toggle */}
            <div className="flex items-center justify-between gap-3">
              <div className="grid gap-1">
                <Label htmlFor="billable" className="cursor-pointer">
                  Billable
                </Label>
                <p className="text-sm text-muted-foreground">
                  {isBillable === null
                    ? "Inherits from client settings."
                    : isBillable
                    ? "Time tracked is billable."
                    : "Time tracked is not billable."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isBillable !== null && (
                  <button
                    type="button"
                    onClick={() => setIsBillable(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Reset
                  </button>
                )}
                <Switch
                  id="billable"
                  checked={isBillable === true}
                  onCheckedChange={(checked) => {
                    setIsBillable(checked);
                  }}
                  disabled={isDisabled}
                />
              </div>
            </div>

            {/* Archive status (edit mode only) */}
            {isEditing && project?.isArchived && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  This project is archived. It won&apos;t appear in time entry
                  suggestions.
                </p>
              </div>
            )}

            {/* Tasks section (edit mode only) */}
            {isEditing && project && (
              <div className="border-t pt-5">
                <ProjectTasks orgId={orgId} projectId={project.id} />
              </div>
            )}

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            {isEditing && (
              <div className="mr-auto flex gap-2">
                {/* Archive/Unarchive button */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleArchive}
                  disabled={isDisabled}
                  className="squircle"
                >
                  {isArchiving && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  {project?.isArchived ? (
                    <>
                      <ArchiveRestore className="size-4" />
                      Unarchive
                    </>
                  ) : (
                    <>
                      <Archive className="size-4" />
                      Archive
                    </>
                  )}
                </Button>

                {/* Delete button */}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={isDisabled}
                      className="squircle"
                    >
                      {isDeleting && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="squircle">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete project?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete &quot;{project?.name}&quot;
                        and all associated tasks and time entries. This action
                        cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="squircle">
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDelete}
                        className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isDisabled}
              className="squircle"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isDisabled || !name.trim() || !clientId}
              className="squircle"
            >
              {isLoading && <Loader2 className="size-4 animate-spin" />}
              {isEditing ? "Save changes" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
