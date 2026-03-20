"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function AdminActions() {
  const [pruning, setPruning] = useState(false);

  async function handleDockerPrune() {
    setPruning(true);
    try {
      const res = await fetch("/api/v1/admin/docker-prune", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Cleaned up ${data.spaceReclaimed || "unused resources"}`);
      } else {
        toast.error("Cleanup failed");
      }
    } catch {
      toast.error("Cleanup failed");
    } finally {
      setPruning(false);
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">Maintenance</h2>

      <div className="space-y-2">
        <div className="flex items-center justify-between rounded-lg border bg-card p-4">
          <div>
            <p className="text-sm font-medium">Docker Cleanup</p>
            <p className="text-xs text-muted-foreground">
              Remove unused images, stopped containers, and dangling volumes.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={handleDockerPrune} disabled={pruning}>
            {pruning ? (
              <><Loader2 className="mr-1.5 size-4 animate-spin" />Cleaning...</>
            ) : (
              <><Trash2 className="mr-1.5 size-4" />Clean Up</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
