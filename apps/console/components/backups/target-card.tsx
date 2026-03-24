"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { TargetIcon, targetSubtitle } from "./constants";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import type { BackupTarget } from "./types";

export function TargetCard({
  target,
  orgId,
  readOnly = false,
  onRefresh,
  onEdit,
}: {
  target: BackupTarget;
  orgId: string;
  readOnly?: boolean;
  onRefresh: () => void;
  onEdit?: () => void;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function deleteTarget() {
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/backups/targets/${target.id}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        toast.success("Target deleted");
        setDeleteOpen(false);
        onRefresh();
      } else {
        toast.error("Failed to delete target");
      }
    } catch {
      toast.error("Failed to delete target");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="squircle rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <TargetIcon type={target.type} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{target.name}</p>
                <Badge variant="secondary" className="text-xs">{target.type}</Badge>
                {target.isDefault && (
                  <Badge variant="outline" className="text-xs">default</Badge>
                )}
                {target.isAppLevel && (
                  <Badge variant="outline" className="text-xs">System</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                {targetSubtitle(target)}
              </p>
            </div>
          </div>
          {!readOnly && (
            <div className="flex items-center gap-1">
              {onEdit && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Edit target"
                  onClick={onEdit}
                >
                  <Pencil className="size-3.5" />
                </Button>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Delete target"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      </div>

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete storage target"
        description="This will remove the target. Existing backup files in storage won't be deleted, but jobs using this target will stop working."
        onConfirm={deleteTarget}
        loading={deleting}
      />
    </>
  );
}
