"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, Download, Loader2, Play, Power, PowerOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { RelativeTime } from "@/components/relative-time";
import { toast } from "@/lib/messenger";
import { formatBytes, formatDuration } from "@/lib/metrics/format";
import { MIN_VALID_GZIP_BYTES } from "@/lib/backups/archive";
import { KeyEscrowCard } from "./key-escrow-card";
import { StatusBadge } from "./status-badge";
import { NextRun } from "./next-run";
import { RetentionSummary } from "./retention-summary";
import { scheduleLabel } from "./constants";
import { failureReason } from "./history-state";
import { SystemStorageForm, type SystemStorage } from "./system-storage-form";
import type { BackupJob } from "./types";

type SystemRun = {
  id: string;
  status: string;
  sizeBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  storagePath: string | null;
  log: string | null;
};

type SystemJob = Omit<BackupJob, "backupJobApps" | "backups" | "target"> & {
  lastRunAt: string | null;
  target: { id: string; name: string; type: string } | null;
};

type SystemBackup = { storage: SystemStorage; job: SystemJob | null; history: SystemRun[] };

function sizeLabel(bytes: number | null) {
  if (bytes == null) return "—";
  return bytes < MIN_VALID_GZIP_BYTES ? "Empty" : formatBytes(bytes);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 text-sm">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** Vardo's own database: where it's backed up, when, and how the last runs went. */
export function SystemBackupSection() {
  const [data, setData] = useState<SystemBackup | null>(null);
  const [failed, setFailed] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/admin/system-backup");
      if (!res.ok) throw new Error();
      setData(await res.json());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function runNow() {
    setRunning(true);
    try {
      const res = await fetch("/api/v1/admin/system-backup/run", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) toast.success("Database backed up");
      else toast.error(body?.results?.find((r: { error?: string }) => r.error)?.error ?? body?.error ?? "Couldn't back up the database");
    } catch {
      toast.error("Couldn't back up the database");
    } finally {
      setRunning(false);
      load();
    }
  }

  if (failed) {
    return (
      <EmptyState className="p-8" title="Couldn't load database backup" body="Reload the page to try again." />
    );
  }
  if (!data) {
    return (
      <div className="flex items-center justify-center py-12" role="status">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading database backup</span>
      </div>
    );
  }

  const { storage, job, history } = data;
  const last = history[0];

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="type-h2">Vardo&apos;s database</h2>
        <p className="text-sm text-muted-foreground">
          Every app definition, variable and domain. Backed up to its own storage, apart from organization targets.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-4">
            <CardTitle as="h3">Backup storage</CardTitle>
          </CardHeader>
          <CardContent>
            <SystemStorageForm storage={storage} onSaved={load} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <CardTitle as="h3">Backup job</CardTitle>
            {job && (
              <Button size="sm" variant="outline" disabled={running} onClick={runNow}>
                {running ? (
                  <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Play className="mr-1.5 size-4" aria-hidden="true" />
                )}
                Run now
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {!job ? (
              <EmptyState
                className="p-8"
                icon={Archive}
                title="No backup job yet"
                body="Save backup storage and Vardo schedules a daily backup of its database."
              />
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{job.name}</p>
                  {job.enabled ? (
                    <Badge variant="success" className="text-xs">
                      <Power className="mr-1 size-3" aria-hidden="true" />
                      Active
                    </Badge>
                  ) : (
                    <Badge variant="neutral" className="text-xs">
                      <PowerOff className="mr-1 size-3" aria-hidden="true" />
                      Paused
                    </Badge>
                  )}
                </div>
                <dl className="space-y-2">
                  <Row label="Schedule">{scheduleLabel(job.schedule)}</Row>
                  <Row label="Next run">
                    {job.enabled ? <NextRun schedule={job.schedule} /> : <span className="text-muted-foreground">Paused</span>}
                  </Row>
                  <Row label="Last run">
                    {last ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={last.status} />
                        <RelativeTime date={last.startedAt} className="text-muted-foreground" />
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Never</span>
                    )}
                  </Row>
                  <Row label="Retention"><RetentionSummary job={job} /></Row>
                  <Row label="Target">{job.target?.name ?? "—"}</Row>
                </dl>
                {last && (last.status === "failed" || last.status === "skipped") && failureReason(last.log) && (
                  <p className="text-xs text-destructive">{failureReason(last.log)}</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <KeyEscrowCard heading="h3" />

      <Card>
        <CardHeader>
          <CardTitle as="h3">Database backup history</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <EmptyState
              className="p-8"
              icon={Archive}
              title="No database backups yet"
              body="Backups appear here after the first scheduled or manual run."
            />
          ) : (
            <Card variant="inset" className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-background-deep">
                    <th className="px-4 py-2 text-left type-label text-muted-foreground">Status</th>
                    <th className="px-4 py-2 text-left type-label text-muted-foreground">Runtime</th>
                    <th className="px-4 py-2 text-left type-label text-muted-foreground">Size</th>
                    <th className="px-4 py-2 text-left type-label text-muted-foreground">Created</th>
                    <th className="px-4 py-2 text-right type-label text-muted-foreground">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((run) => {
                    const reason = run.status === "failed" || run.status === "skipped" ? failureReason(run.log) : null;
                    return (
                      <tr key={run.id} className="border-b last:border-0">
                        <td className="px-4 py-3">
                          <StatusBadge status={run.status} />
                          {reason && <p className="mt-1 max-w-xs truncate text-xs text-destructive" title={reason}>{reason}</p>}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                          {run.finishedAt ? formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) : "—"}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{sizeLabel(run.sizeBytes)}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          <RelativeTime date={run.startedAt} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          {run.status === "success" && run.storagePath && (
                            <Button size="icon-xs" variant="ghost" aria-label="Download backup" asChild>
                              <a href={`/api/v1/admin/backups/${run.id}/download`}>
                                <Download className="size-3.5" aria-hidden="true" />
                              </a>
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
