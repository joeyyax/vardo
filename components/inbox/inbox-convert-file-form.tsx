"use client";

import { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ProjectSelector } from "@/components/expenses/project-selector";
import { toast } from "sonner";
import type { InboxItem } from "./types";

type InboxConvertFileFormProps = {
  orgId: string;
  item: InboxItem;
  onConverted: () => void;
  onCancel: () => void;
};

export function InboxConvertFileForm({
  orgId,
  item,
  onConverted,
  onCancel,
}: InboxConvertFileFormProps) {
  const [projectId, setProjectId] = useState<string | null>(item.projectId);
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!projectId) {
      toast.error("Project is required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox/${item.id}/convert-file`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to convert");
      }

      onConverted();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save files"
      );
    } finally {
      setSubmitting(false);
    }
  }

  const fileCount = item.files.length;

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-medium">Save Files</h3>

      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {fileCount} {fileCount === 1 ? "file" : "files"} will be saved to the
          selected project.
        </p>

        <div className="space-y-1.5">
          <Label>Project</Label>
          <ProjectSelector
            orgId={orgId}
            selectedProjectId={projectId}
            onSelect={setProjectId}
            open={projectSelectorOpen}
            onOpenChange={setProjectSelectorOpen}
          >
            <Button
              variant="outline"
              role="combobox"
              className="w-full justify-between font-normal"
              type="button"
            >
              {projectId
                ? item.project?.id === projectId
                  ? item.project.name
                  : "Project selected"
                : "Select a project"}
              <ChevronDown className="ml-2 size-4 opacity-50" />
            </Button>
          </ProjectSelector>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !projectId}>
          {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
          Save Files
        </Button>
      </div>
    </form>
  );
}
