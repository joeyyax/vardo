"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { TargetIcon, targetSubtitle } from "./constants";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { plural, usageSummary } from "./delete-copy";
import type { BackupTarget, TargetUsage } from "./types";
import { Card } from "@/components/ui/card";

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
  const [usage, setUsage] = useState<TargetUsage | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);
  const [typed, setTyped] = useState("");

  const url = `/api/v1/organizations/${orgId}/backups/targets/${target.id}`;
  const inUse = !!usage && (usage.backups > 0 || usage.jobs > 0);

  async function openDelete() {
    setUsage(null);
    setUsageFailed(false);
    setTyped("");
    setDeleteOpen(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      setUsage((await res.json()).usage);
    } catch {
      setUsageFailed(true);
    }
  }

  async function deleteTarget() {
    setDeleting(true);
    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inUse ? { confirm: typed } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't delete target");
        if (data.usage) setUsage(data.usage);
        return;
      }
      toast.success("Target deleted");
      if (data.archivesLeft > 0) {
        toast.warning(`${plural(data.archivesLeft, "archive")} couldn't be deleted from storage`);
      }
      setDeleteOpen(false);
      onRefresh();
    } catch {
      toast.error("Couldn't delete target");
    } finally {
      setDeleting(false);
    }
  }

  const description = usageFailed
    ? "Couldn't check what uses this target."
    : !usage
      ? "Checking what uses this target…"
      : usage.inProgress > 0
        ? "A backup is writing to this target. Try again once it finishes."
        : inUse
          ? usageSummary(usage, !!target.isAppLevel)
          : "Nothing uses this target. Its storage isn't touched.";

  return (
    <>
      <Card variant="inset" className="p-4">
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
                onClick={openDelete}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      </Card>

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${target.name}`}
        description={description}
        onConfirm={deleteTarget}
        loading={deleting}
        confirmDisabled={
          !usage || usage.inProgress > 0 || (inUse && typed !== target.name)
        }
      >
        {inUse && usage.inProgress === 0 && (
          <div className="space-y-1.5 text-sm">
            <label htmlFor={`delete-target-${target.id}`} className="block">
              Type <span className="font-mono font-medium">{target.name}</span> to delete it and
              everything on it
            </label>
            <Input
              id={`delete-target-${target.id}`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </div>
        )}
      </ConfirmDeleteDialog>
    </>
  );
}
