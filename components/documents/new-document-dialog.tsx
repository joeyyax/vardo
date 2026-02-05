"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

type Project = {
  id: string;
  name: string;
  client: {
    id: string;
    name: string;
  };
};

type NewDocumentDialogProps = {
  orgId: string;
  type: "proposal" | "contract";
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function NewDocumentDialog({
  orgId,
  type,
  open,
  onOpenChange,
}: NewDocumentDialogProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  // Form state
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");

  // Fetch projects when dialog opens
  useEffect(() => {
    if (open && projects.length === 0) {
      fetchProjects();
    }
  }, [open]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setTitle("");
      setProjectId("");
    }
  }, [open]);

  async function fetchProjects() {
    setProjectsLoading(true);
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/projects`);
      if (response.ok) {
        const data = await response.json();
        setProjects(data.projects || data);
      }
    } catch (err) {
      console.error("Error fetching projects:", err);
    } finally {
      setProjectsLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!projectId) {
      toast.error("Please select a project");
      return;
    }

    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            title: title.trim(),
            content: {
              sections: [
                {
                  id: crypto.randomUUID(),
                  type: "text",
                  title: type === "proposal" ? "Overview" : "Agreement",
                  content: "",
                },
              ],
            },
          }),
        }
      );

      if (response.ok) {
        const document = await response.json();
        toast.success(`${type === "proposal" ? "Proposal" : "Contract"} created`);
        onOpenChange(false);
        router.push(`/projects/${projectId}/documents/${document.id}`);
      } else {
        const data = await response.json();
        toast.error(data.error || `Failed to create ${type}`);
      }
    } catch (err) {
      console.error(`Error creating ${type}:`, err);
      toast.error(`Failed to create ${type}`);
    } finally {
      setIsLoading(false);
    }
  }

  // Group projects by client for the dropdown
  const projectsByClient = projects.reduce((acc, project) => {
    const clientName = project.client.name;
    if (!acc[clientName]) {
      acc[clientName] = [];
    }
    acc[clientName].push(project);
    return acc;
  }, {} as Record<string, Project[]>);

  const typeLabel = type === "proposal" ? "Proposal" : "Contract";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>New {typeLabel}</DialogTitle>
          <DialogDescription>
            Create a new {type} for a project.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="project">Project</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="project" className="squircle">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent className="squircle">
                {projectsLoading ? (
                  <div className="flex items-center justify-center py-2">
                    <Loader2 className="size-4 animate-spin" />
                  </div>
                ) : projects.length === 0 ? (
                  <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                    No projects found. Create a project first.
                  </div>
                ) : (
                  Object.entries(projectsByClient).map(([clientName, clientProjects]) => (
                    <div key={clientName}>
                      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                        {clientName}
                      </div>
                      {clientProjects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </div>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`e.g., Website Redesign ${typeLabel}`}
              className="squircle"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="squircle"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isLoading || !projectId}
              className="squircle"
            >
              {isLoading && <Loader2 className="size-4 animate-spin" />}
              Create {typeLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
