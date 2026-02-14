"use client";

import { useState, useEffect } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ProjectSelector } from "@/components/expenses/project-selector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import type { InboxItem } from "./types";

type InboxTransferFormProps = {
  orgId: string;
  item: InboxItem;
  onConverted: () => void;
  onCancel: () => void;
};

type ClientOption = { id: string; name: string };

export function InboxTransferForm({
  orgId,
  item,
  onConverted,
  onCancel,
}: InboxTransferFormProps) {
  const [mode, setMode] = useState<"project" | "client">("project");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Fetch clients for org-level items that need the client-only path
  const needsClients = !item.clientId && !item.projectId;
  useEffect(() => {
    if (!needsClients) return;
    async function fetchClients() {
      try {
        const res = await fetch(`/api/v1/organizations/${orgId}/clients`);
        if (res.ok) {
          const data = await res.json();
          setClients(
            (data.clients || data).map((c: ClientOption) => ({
              id: c.id,
              name: c.name,
            }))
          );
        }
      } catch {
        // Non-blocking
      }
    }
    fetchClients();
  }, [orgId, needsClients]);

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

    const payload: Record<string, string> = {};

    if (mode === "project") {
      if (!projectId) {
        toast.error("Select a project to transfer to");
        return;
      }
      payload.projectId = projectId;
    } else {
      if (!clientId) {
        toast.error("Select a client to transfer to");
        return;
      }
      payload.clientId = clientId;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox/${item.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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

  // Has client but no project — only project assignment available
  if (item.clientId) {
    return (
      <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
        <h3 className="text-sm font-medium">Transfer Item</h3>
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Assign this item to a specific project under this client.
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

  // Org-level item — can assign to project (auto-sets client) or client only
  const isValid = mode === "project" ? !!projectId : !!clientId;

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-medium">Transfer Item</h3>

      <div className="grid gap-3">
        <div className="space-y-1.5">
          <Label>Assign to</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as "project" | "client")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">A project</SelectItem>
              <SelectItem value="client">A client only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {mode === "project" ? (
          <div className="space-y-1.5">
            <Label>Project</Label>
            <p className="text-xs text-muted-foreground">
              The client will be set automatically.
            </p>
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
        ) : (
          <div className="space-y-1.5">
            <Label>Client</Label>
            <p className="text-xs text-muted-foreground">
              You can assign to a specific project later.
            </p>
            <Select value={clientId ?? ""} onValueChange={setClientId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a client" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !isValid}>
          {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
          Transfer
        </Button>
      </div>
    </form>
  );
}
