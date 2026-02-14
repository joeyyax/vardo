"use client";

import { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ProjectSelector } from "@/components/expenses/project-selector";
import { toast } from "sonner";
import type { InboxItem } from "./types";

type InboxTransferFormProps = {
  orgId: string;
  item: InboxItem;
  onConverted: () => void;
  onCancel: () => void;
};

export function InboxTransferForm({
  orgId,
  item,
  onConverted,
  onCancel,
}: InboxTransferFormProps) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Item already at most specific scope — can't transfer further down
  if (item.projectId) {
    return (
      <div className="space-y-4 rounded-md border p-4">
        <h3 className="text-sm font-medium">Transfer Item</h3>
        <p className="text-sm text-muted-foreground">
          This item is already scoped to a project and cannot be transferred
          further.
        </p>
        <div className="flex items-center justify-end pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!projectId) {
      toast.error("Select a project to transfer to");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox/${item.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to transfer");
      }

      toast.success("Item transferred");
      onConverted();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to transfer item"
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Has client but no project — show project selector filtered to this client
  // No scope at all — show project selector (picking a project auto-sets client)
  const description = item.clientId
    ? "Assign this item to a specific project under this client."
    : "Assign this item to a project. The client will be set automatically.";

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-medium">Transfer Item</h3>

      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">{description}</p>

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
              {projectId ? "Project selected" : "Select a project"}
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
          Transfer
        </Button>
      </div>
    </form>
  );
}
