"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Archive, Download, Loader2, RotateCcw } from "lucide-react";
import { formatBytes } from "@/lib/metrics/format";
import { toast } from "@/lib/messenger";
import { StatusBadge } from "./status-badge";
import type { RecentBackup } from "./types";

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
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
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
        <Archive className="size-8 text-muted-foreground/50" aria-hidden="true" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">No backups yet</p>
          <p className="text-sm text-muted-foreground">
            Backups will appear here after the first scheduled or manual run.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">App</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Job</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Runtime</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Size</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Created</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">
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
              <td className="px-4 py-3 font-medium">{backup.app.displayName}</td>
              <td className="px-4 py-3 text-muted-foreground">{backup.job.name}</td>
              <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                {formatDuration(backup.startedAt, backup.finishedAt)}
              </td>
              <td className="px-4 py-3 text-muted-foreground text-xs">
                {backup.sizeBytes != null ? formatBytes(backup.sizeBytes) : "—"}
              </td>
              <td className="px-4 py-3 text-muted-foreground text-xs" title={new Date(backup.startedAt).toLocaleString()}>
                {formatRelativeTime(backup.startedAt)}
              </td>
              <td className="px-4 py-3 text-right">
                <span className="flex justify-end gap-1">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title="Restore"
                    disabled={restoringBackups.has(backup.id)}
                    onClick={() => restoreBackup(backup.id)}
                  >
                    {restoringBackups.has(backup.id) ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <RotateCcw className="size-3.5" aria-hidden="true" />
                    )}
                  </Button>
                  {backup.storagePath && (
                    <Button size="icon-xs" variant="ghost" title="Download" asChild>
                      <a href={`/api/v1/organizations/${orgId}/backups/history/${backup.id}/download`}>
                        <Download className="size-3.5" aria-hidden="true" />
                      </a>
                    </Button>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
