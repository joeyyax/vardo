"use client";

import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Archive, Download, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { formatDuration } from "@/lib/metrics/format";
import { DOWNLOAD_HINT } from "@/lib/backups/archive-name";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "./status-badge";
import { RestoreTestBadge } from "./restore-test-badge";
import { failureReason, isEncryptedRun, restoreTestFor } from "./history-state";
import { EncryptedMark } from "./encrypted-mark";
import { TermScope } from "@/components/term";
import { useBackupActions } from "./use-backup-actions";
import { archiveSize } from "./job-state";
import { useCan } from "@/components/capabilities-provider";
import type { RecentBackup } from "./types";
import { Card } from "@/components/ui/card";
import { EntityLink } from "@/components/entity-link";
import { appHref } from "@/lib/ui/hrefs";
import { jobAnchor } from "./job-anchor";

const TRIGGER_LABELS: Record<string, string> = {
  initial: "Initial snapshot",
  import: "After import",
  requeue: "Rerun after restart",
};

function backupDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—";
  return formatDuration(new Date(finishedAt).getTime() - new Date(startedAt).getTime());
}

export function BackupHistory({
  history,
  orgId,
  onRefresh,
  jobHref = (id) => `#${jobAnchor(id)}`,
}: {
  history: RecentBackup[];
  orgId: string;
  onRefresh: () => void;
  /** Where a run's job name links. Defaults to the job card on the same page. */
  jobHref?: (jobId: string) => string;
}) {
  const can = useCan();
  const { restoring: restoringBackups, askRestore, askDelete, dialogs } = useBackupActions({ orgId, onRefresh });

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
    <TermScope>
    <Card variant="inset" className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-background-deep">
            <th className="px-4 py-2 text-left type-label text-muted-foreground">Status</th>
            <th className="px-4 py-2 text-left type-label text-muted-foreground">App</th>
            <th className="px-4 py-2 text-left type-label text-muted-foreground">Job</th>
            <th className="px-4 py-2 text-left type-label text-muted-foreground">Runtime</th>
            <th className="px-4 py-2 text-left type-label text-muted-foreground">Size</th>
            <th className="px-4 py-2 text-left type-label text-muted-foreground">Restore test</th>
            <th className="px-4 py-2 text-left type-label text-muted-foreground">Created</th>
            <th className="px-4 py-2 text-right type-label text-muted-foreground">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {history.map((backup) => {
            const reason =
              backup.status === "failed" || backup.status === "skipped" ? failureReason(backup.log) : null;
            return (
            <Fragment key={backup.id}>
            <tr className={reason ? "" : "border-b last:border-0"}>
              <td className="px-4 py-3">
                <StatusBadge status={backup.status} />
                {isEncryptedRun(backup) && <EncryptedMark href="/backups#recovery-key" className="mt-1 flex" />}
              </td>
              <td className="px-4 py-3 font-medium">
                {backup.app ? (
                  <EntityLink href={appHref(backup.app.name, "backups")}>{backup.app.displayName}</EntityLink>
                ) : (
                  <>
                    {backup.appName ?? "Unknown app"}{" "}
                    <span className="font-normal text-muted-foreground">(deleted)</span>
                  </>
                )}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {backup.job ? (
                  <EntityLink href={jobHref(backup.job.id)}>{backup.job.name}</EntityLink>
                ) : (
                  `${backup.jobName ?? "Unknown job"} (deleted)`
                )}
                {backup.trigger && TRIGGER_LABELS[backup.trigger] && (
                  <span className="block text-xs">{TRIGGER_LABELS[backup.trigger]}</span>
                )}
              </td>
              <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                {backupDuration(backup.startedAt, backup.finishedAt)}
              </td>
              <td className="px-4 py-3 text-muted-foreground text-xs">
                {archiveSize(backup.sizeBytes)}
              </td>
              <td className="px-4 py-3 text-xs">
                <RestoreTestBadge test={restoreTestFor(backup)} />
              </td>
              <td className="px-4 py-3 text-muted-foreground text-xs">
                <RelativeTime date={backup.startedAt} />
              </td>
              <td className="px-4 py-3 text-right">
                <span className="flex justify-end gap-1">
                  {/* Skipped and failed runs have no archive to act on. */}
                  {backup.storagePath && (
                    <>
                      {backup.app && can("backup.restore") && (
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Restore backup"
                          disabled={restoringBackups.has(backup.id)}
                          onClick={() => askRestore(backup)}
                        >
                          {restoringBackups.has(backup.id) ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <RotateCcw className="size-3.5" aria-hidden="true" />
                          )}
                        </Button>
                      )}
                      {can("backup.download") && (
                        <Button size="icon-xs" variant="ghost" aria-label="Download backup" title={DOWNLOAD_HINT} asChild>
                          <a href={`/api/v1/organizations/${orgId}/backups/history/${backup.id}/download`}>
                            <Download className="size-3.5" aria-hidden="true" />
                          </a>
                        </Button>
                      )}
                    </>
                  )}
                  {can("backup.delete") && backup.status !== "pending" && backup.status !== "running" && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Delete backup"
                      onClick={() => askDelete(backup)}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  )}
                </span>
              </td>
            </tr>
            {reason && (
              <tr className="border-b last:border-0">
                <td colSpan={8} className="px-4 pb-3 pt-0">
                  <details className="text-xs">
                    <summary className="cursor-pointer text-destructive">{reason}</summary>
                    {backup.log && (
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 font-mono text-muted-foreground">
                        {backup.log}
                      </pre>
                    )}
                  </details>
                </td>
              </tr>
            )}
            </Fragment>
            );
          })}
        </tbody>
      </table>

      {dialogs}
    </Card>
    </TermScope>
  );
}
