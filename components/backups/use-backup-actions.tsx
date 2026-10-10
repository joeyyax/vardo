"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { formatBytes } from "@/lib/metrics/format";
import { toast } from "@/lib/messenger";
import { deleteDescription, orphanScope, plural } from "./delete-copy";
import { isEncryptedRun } from "./history-state";
import type { RecentBackup } from "./types";

/** Restore and delete for backup runs, with their confirmations. Render `dialogs` once. */
export function useBackupActions({ orgId, onRefresh }: { orgId: string; onRefresh: () => void }) {
  const [restoring, setRestoring] = useState<Set<string>>(new Set());
  const [pendingRestore, setPendingRestore] = useState<RecentBackup | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<RecentBackup | null>(null);
  const [deleteAll, setDeleteAll] = useState(false);
  const [orphanTotal, setOrphanTotal] = useState<{ backups: number; bytes: number } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const pendingScope = pendingDelete ? orphanScope(pendingDelete) : null;

  async function askDelete(backup: RecentBackup) {
    setPendingDelete(backup);
    setDeleteAll(false);
    setOrphanTotal(null);
    const scope = orphanScope(backup);
    if (!scope) return;
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups/history?${scope.query}`);
      if (res.ok) setOrphanTotal(await res.json());
    } catch {
      // The single delete still works.
    }
  }

  function askRestore(backup: RecentBackup) {
    setAcknowledged(false);
    setPendingRestore(backup);
  }

  async function deleteBackup() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const base = `/api/v1/organizations/${orgId}/backups/history`;
      const res = await fetch(
        deleteAll && pendingScope ? `${base}?${pendingScope.query}` : `${base}/${pendingDelete.id}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't delete backup");
        return;
      }
      if (deleteAll) {
        toast.success(`${plural(data.deleted, "backup")} deleted`);
        if (data.kept > 0) {
          toast.warning(`${plural(data.kept, "backup")} kept: storage wouldn't delete the archive`);
        }
      } else {
        toast.success("Backup deleted");
      }
      setPendingDelete(null);
      onRefresh();
    } catch {
      toast.error("Couldn't delete backup");
    } finally {
      setDeleting(false);
    }
  }

  async function restoreBackup(backupId: string) {
    setRestoring((prev) => new Set([...prev, backupId]));
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups/history/${backupId}/restore`, { method: "POST" });
      if (res.ok) {
        toast.success("Backup restored");
        onRefresh();
      } else {
        toast.error("Restore failed");
      }
    } catch {
      toast.error("Restore failed");
    } finally {
      setRestoring((prev) => {
        const next = new Set(prev);
        next.delete(backupId);
        return next;
      });
    }
  }

  const dialogs = (
    <>
      <ConfirmDeleteDialog
        open={!!pendingRestore}
        onOpenChange={(open) => {
          if (!open) setPendingRestore(null);
        }}
        onConfirm={() => {
          const id = pendingRestore?.id;
          setPendingRestore(null);
          if (id) restoreBackup(id);
        }}
        title="Restore this backup"
        description={
          pendingRestore
            ? `This overwrites ${pendingRestore.app?.displayName}'s current volume data with the archive from ${new Date(pendingRestore.startedAt).toLocaleString()}. Containers using a restored volume stop until it finishes. Anything written since is lost, and there is no undo.${isEncryptedRun(pendingRestore) ? " Restoring on a different server needs this server's recovery key." : ""}`
            : ""
        }
        confirmLabel="Restore"
        loadingLabel="Restoring..."
        confirmDisabled={!acknowledged}
      >
        <label className="flex cursor-pointer select-none items-start gap-3">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(checked) => setAcknowledged(checked === true)}
            className="mt-0.5"
          />
          <span className="text-sm text-muted-foreground">I understand current data will be overwritten</span>
        </label>
      </ConfirmDeleteDialog>

      <ConfirmDeleteDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={deleteBackup}
        loading={deleting}
        title="Delete backup"
        description={
          !pendingDelete
            ? ""
            : deleteAll && pendingScope && orphanTotal
              ? `Deletes all ${plural(orphanTotal.backups, "backup")} of ${pendingScope.label} and their archives (${formatBytes(orphanTotal.bytes)}) from storage. This can't be undone.`
              : deleteDescription(pendingDelete)
        }
      >
        {pendingScope && orphanTotal && orphanTotal.backups > 1 && (
          <label className="flex cursor-pointer select-none items-start gap-3">
            <Checkbox
              checked={deleteAll}
              onCheckedChange={(checked) => setDeleteAll(checked === true)}
              className="mt-0.5"
            />
            <span className="text-sm text-muted-foreground">
              Delete all {orphanTotal.backups} backups of {pendingScope.label}
            </span>
          </label>
        )}
      </ConfirmDeleteDialog>
    </>
  );

  return { restoring, askRestore, askDelete, dialogs };
}
