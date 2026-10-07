"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Archive, Download, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { formatBytes } from "@/lib/metrics/format";
import { MIN_VALID_GZIP_BYTES } from "@/lib/backups/archive";
import { toast } from "@/lib/messenger";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "./status-badge";
import { deleteDescription, orphanScope, plural } from "./delete-copy";
import type { RecentBackup } from "./types";

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * A stored archive under the floor only exists because the engine confirmed the
 * source empty, so show that rather than a byte count nobody can interpret.
 */
function formatArchiveSize(sizeBytes: number | null): string {
  if (sizeBytes == null) return "—";
  if (sizeBytes < MIN_VALID_GZIP_BYTES) return "Empty";
  return formatBytes(sizeBytes);
}

export function BackupHistory({
  history,
  orgId,
  onRefresh,
}: {
  history: RecentBackup[];
  orgId: string;
  onRefresh: () => void;
}) {
  const [restoringBackups, setRestoringBackups] = useState<Set<string>>(new Set());
  const [pendingRestore, setPendingRestore] = useState<RecentBackup | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<RecentBackup | null>(null);
  const [deleteAll, setDeleteAll] = useState(false);
  const [orphanTotal, setOrphanTotal] = useState<{ backups: number; bytes: number } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const pendingScope = pendingDelete ? orphanScope(pendingDelete) : null;

  async function openDelete(backup: RecentBackup) {
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
        toast.error(data.error ?? "Failed to delete backup");
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
      toast.error("Failed to delete backup");
    } finally {
      setDeleting(false);
    }
  }

  async function restoreBackup(backupId: string) {
    setRestoringBackups((prev) => new Set([...prev, backupId]));
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/backups/history/${backupId}/restore`,
        { method: "POST" }
      );
      if (res.ok) {
        toast.success("Backup restored");
        onRefresh();
      } else {
        toast.error("Restore failed");
      }
    } catch {
      toast.error("Restore failed");
    } finally {
      setRestoringBackups((prev) => {
        const next = new Set(prev);
        next.delete(backupId);
        return next;
      });
    }
  }

  if (history.length === 0) {
    return (
      <EmptyState
        className="p-8"
        icon={Archive}
        title="No backups yet"
        body="Backups appear here after the first scheduled or manual run."
      />
    );
  }

  return (
    <div className="squircle rounded-lg bg-background-deep overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-background-deep">
            <th className="px-4 py-2 text-left type-label text-muted-foreground">Status</th>
            <th className="px-4 py-2 text-left type-label text-muted-foreground">App</th>
            <th className="px-4 py-2 text-left type-label text-muted-foreground">Job</th>
            <th className="px-4 py-2 text-left type-label text-muted-foreground">Runtime</th>
            <th className="px-4 py-2 text-left type-label text-muted-foreground">Size</th>
            <th className="px-4 py-2 text-left type-label text-muted-foreground">Created</th>
            <th className="px-4 py-2 text-right type-label text-muted-foreground">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {history.map((backup) => (
            <tr key={backup.id} className="border-b last:border-0">
              <td className="px-4 py-3">
                <StatusBadge status={backup.status} />
              </td>
              <td className="px-4 py-3 font-medium">
                {backup.app ? (
                  backup.app.displayName
                ) : (
                  <>
                    {backup.appName ?? "Unknown app"}{" "}
                    <span className="font-normal text-muted-foreground">(deleted)</span>
                  </>
                )}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {backup.job ? backup.job.name : `${backup.jobName ?? "Unknown job"} (deleted)`}
              </td>
              <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                {formatDuration(backup.startedAt, backup.finishedAt)}
              </td>
              <td className="px-4 py-3 text-muted-foreground text-xs">
                {formatArchiveSize(backup.sizeBytes)}
              </td>
              <td className="px-4 py-3 text-muted-foreground text-xs">
                <RelativeTime date={backup.startedAt} />
              </td>
              <td className="px-4 py-3 text-right">
                <span className="flex justify-end gap-1">
                  {/* Skipped and failed runs have no archive to act on. */}
                  {backup.storagePath && (
                    <>
                      {backup.app && (
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Restore backup"
                          disabled={restoringBackups.has(backup.id)}
                          onClick={() => {
                            setAcknowledged(false);
                            setPendingRestore(backup);
                          }}
                        >
                          {restoringBackups.has(backup.id) ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <RotateCcw className="size-3.5" aria-hidden="true" />
                          )}
                        </Button>
                      )}
                      <Button size="icon-xs" variant="ghost" aria-label="Download backup" asChild>
                        <a href={`/api/v1/organizations/${orgId}/backups/history/${backup.id}/download`}>
                          <Download className="size-3.5" aria-hidden="true" />
                        </a>
                      </Button>
                    </>
                  )}
                  {backup.status !== "pending" && backup.status !== "running" && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Delete backup"
                      onClick={() => openDelete(backup)}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

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
            ? `This overwrites ${pendingRestore.app?.displayName}'s current volume data with the archive from ${new Date(pendingRestore.startedAt).toLocaleString()}. Containers using a restored volume stop until it finishes. Anything written since is lost, and there is no undo.`
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
          <span className="text-sm text-muted-foreground">
            I understand current data will be overwritten
          </span>
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
    </div>
  );
}
