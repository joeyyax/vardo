"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";

export function PortsManager({
  ports: initialPorts,
  appId,
  orgId,
}: {
  ports: { internal: number; external?: number; protocol?: string; description?: string }[];
  appId: string;
  orgId: string;
}) {
  const router = useRouter();
  const [ports, setPorts] = useState(initialPorts);
  const [adding, setAdding] = useState(false);
  const [newInternal, setNewInternal] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [saving, setSaving] = useState(false);

  async function savePorts(updated: typeof ports) {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exposedPorts: updated }),
      });
      if (!res.ok) {
        toast.error("Failed to update ports");
        return;
      }
      setPorts(updated);
      toast.success("Ports updated — redeploy to apply");
      router.refresh();
    } catch {
      toast.error("Failed to update ports");
    } finally {
      setSaving(false);
    }
  }

  function handleAdd() {
    const internal = parseInt(newInternal);
    if (!internal || internal < 1 || internal > 65535) {
      toast.error("Enter a valid port number (1-65535)");
      return;
    }
    const updated = [...ports, { internal, description: newDescription || undefined }];
    savePorts(updated);
    setAdding(false);
    setNewInternal("");
    setNewDescription("");
  }

  function handleRemove(index: number) {
    const updated = ports.filter((_, i) => i !== index);
    savePorts(updated);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Exposed Ports</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Map container ports to host ports for external access.</p>
        </div>
        <Button size="sm" onClick={() => setAdding(!adding)} disabled={saving}>
          <Plus className="mr-1.5 size-4" />
          Add Port
        </Button>
      </div>

      {adding && (
        <div className="flex items-end gap-3 rounded-lg border bg-card p-4">
          <div className="grid gap-1.5">
            <label htmlFor="port-container" className="text-xs text-muted-foreground">Container Port</label>
            <input
              id="port-container"
              type="number"
              placeholder="8080"
              value={newInternal}
              onChange={(e) => setNewInternal(e.target.value)}
              className="h-9 w-24 rounded-md border bg-background px-3 text-sm font-mono"
            />
          </div>
          <div className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">Host Port</span>
            <div className="flex h-9 items-center rounded-md border bg-muted/50 px-3 text-sm font-mono text-muted-foreground" role="status" aria-label="Host port: auto-assigned">
              Auto
            </div>
          </div>
          <div className="grid gap-1.5 flex-1">
            <label htmlFor="port-label" className="text-xs text-muted-foreground">Label <span className="text-muted-foreground/60">(optional)</span></label>
            <input
              id="port-label"
              placeholder="e.g. HTTP, Database"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <Button size="sm" onClick={handleAdd} disabled={saving || !newInternal}>
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      )}

      {ports.length === 0 && !adding ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8">
          <p className="text-sm text-muted-foreground">
            No ports exposed to the host. Container ports are accessible within the Docker network by default.
            Expose a port to access this service directly.
          </p>
        </div>
      ) : ports.length > 0 && (
        <div className="divide-y rounded-lg border">
          {ports.map((port, i) => (
            <div key={i} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex items-center gap-4">
                <span className="text-sm font-mono">{port.internal}</span>
                <span className="text-xs text-muted-foreground">→</span>
                <span className="text-sm font-mono">
                  {port.external ? `localhost:${port.external}` : <span className="text-muted-foreground">Auto-assigned</span>}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {port.description && (
                  <span className="text-xs text-muted-foreground">{port.description}</span>
                )}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleRemove(i)}
                  disabled={saving}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
