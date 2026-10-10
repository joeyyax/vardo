"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Download, Loader2, Play, Power, PowerOff, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { StatusDot } from "@/components/ui/status-dot";
import { DetailPanel, PanelSection } from "@/components/detail-panel";
import { EntityLink, quietLinkClass } from "@/components/entity-link";
import { ListRow } from "@/components/list-row";
import { SectionHeader, SectionNumber } from "@/components/section-header";
import { RelativeTime } from "@/components/relative-time";
import { useCan } from "@/components/capabilities-provider";
import { focusRowByKey, useRowKeys } from "@/hooks/use-row-keys";
import { DOWNLOAD_HINT } from "@/lib/backups/archive-name";
import { formatBytes, formatDuration } from "@/lib/metrics/format";
import { toast } from "@/lib/messenger";
import { appHref } from "@/lib/ui/hrefs";
import { cn } from "@/lib/utils";
import { scheduleLabel } from "./constants";
import { describeSchedule } from "./schedule-summary";
import { failureReason, restoreTestFor } from "./history-state";
import { jobAnchor } from "./job-anchor";
import { archiveSize, asRecent, isJobOverdue, jobNeedsLook, latestFinished, runMark } from "./job-state";
import { getNextRun } from "./next-run";
import { RestoreTestBadge } from "./restore-test-badge";
import { RetentionSummary } from "./retention-summary";
import { RunProgressLine } from "./run-progress";
import { UncapturedWarning, uncapturedSources } from "./uncaptured-warning";
import { useBackupActions } from "./use-backup-actions";
import type { BackupJob, RecentBackup, RunProgress } from "./types";

const TRIGGER_LABELS: Record<string, string> = {
  initial: "initial snapshot",
  import: "after import",
  requeue: "rerun after restart",
};

/** Modal layers own Escape while they are open. */
function overlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"], [role="menu"]');
}

function runDuration(run: Pick<RecentBackup, "startedAt" | "finishedAt">): string | null {
  return run.finishedAt ? formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) : null;
}

/** "in 3h" or a date, from the job's schedule. Client-only so server and client agree. */
function NextRunText({ schedule, timeZone }: { schedule: string; timeZone?: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => {
      const next = getNextRun(schedule, timeZone);
      if (!next) return setText("manual only");
      const mins = Math.round((next.getTime() - Date.now()) / 60000);
      setText(
        mins < 1 ? "next run now" : mins < 60 ? `next in ${mins}m` : mins < 1440 ? `next in ${Math.round(mins / 60)}h` : `next ${next.toLocaleDateString()}`,
      );
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [schedule, timeZone]);
  return text;
}

type Section = { job: BackupJob; runs: RecentBackup[] };

/**
 * Backup jobs as sections: the job's last run, next run, overdue and stored size in the header,
 * its runs as rows. A run opens in the detail panel.
 */
export function JobSections({
  jobs,
  orphanRuns,
  orgId,
  progress,
  storedBytes,
  readOnly,
  showApps,
  onRefresh,
  onPanelChange,
  empty,
}: {
  jobs: BackupJob[];
  /** Runs whose job is gone. */
  orphanRuns: RecentBackup[];
  orgId: string;
  progress: Record<string, RunProgress | undefined>;
  storedBytes: Record<string, number>;
  readOnly: (job: BackupJob) => boolean;
  showApps: boolean;
  onRefresh: () => void;
  /** Tells the page when a run is open, so it can make room. */
  onPanelChange?: (open: boolean) => void;
  empty?: ReactNode;
}) {
  const can = useCan();
  const pathname = usePathname();
  const params = useSearchParams();
  const listRef = useRef<HTMLDivElement>(null);
  const onRowKeys = useRowKeys(listRef);
  const actions = useBackupActions({ orgId, onRefresh });
  const [now] = useState(() => new Date());

  const sections: Section[] = jobs.map((job) => ({ job, runs: job.backups.map((run) => asRecent(job, run)) }));

  // Healthy jobs start as one calm line.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(jobs.filter((j) => !jobNeedsLook(j, now, !!progress[j.id])).map((j) => j.id)),
  );
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectedId = params.get("run");
  const allRuns = [...sections.flatMap((s) => s.runs), ...orphanRuns];
  const selected = selectedId ? allRuns.find((r) => r.id === selectedId) ?? null : null;

  const setRun = useCallback(
    (id: string | null) => {
      const sp = new URLSearchParams(params.toString());
      if (id) sp.set("run", id);
      else sp.delete("run");
      const qs = sp.toString();
      window.history.replaceState(null, "", (qs ? `${pathname}?${qs}` : pathname) + window.location.hash);
    },
    [params, pathname],
  );

  const runHref = (id: string) => {
    const sp = new URLSearchParams(params.toString());
    sp.set("run", id);
    return `${pathname}?${sp.toString()}`;
  };

  const close = useCallback(() => {
    const from = selectedId;
    setRun(null);
    if (from) requestAnimationFrame(() => focusRowByKey(listRef.current, from));
  }, [selectedId, setRun]);

  useEffect(() => onPanelChange?.(!!selected), [selected, onPanelChange]);

  useEffect(() => {
    if (!selected) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || overlayOpen()) return;
      close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selected, close]);

  const row = (run: RecentBackup, jobId: string | null) => {
    const reason = run.status === "failed" || run.status === "skipped" ? failureReason(run.log) : null;
    const live = jobId ? progress[jobId] : undefined;
    const signal = [run.volumeName, run.trigger ? TRIGGER_LABELS[run.trigger] : null].filter(Boolean).join(" · ");
    const took = runDuration(run);
    const test = restoreTestFor(run);
    return (
      <ListRow
        key={run.id}
        navKey={run.id}
        mark={runMark(run.status)}
        name={run.app?.displayName ?? `${run.appName ?? "Unknown app"} (deleted)`}
        href={run.app ? appHref(run.app.name, "backups") : runHref(run.id)}
        linkOpens={!run.app}
        signal={signal || undefined}
        status={
          <span className="flex min-w-0 items-center gap-3 text-muted-foreground/70 tabular-nums">
            {reason ? (
              <span className={cn("min-w-0 truncate", run.status === "failed" ? "text-status-error" : "text-status-warning")} title={reason}>
                {reason}
              </span>
            ) : run.status === "running" && live ? (
              <span className="min-w-0 truncate text-status-info">
                {live.index} of {live.total}
              </span>
            ) : run.status === "success" ? (
              <span className="max-sm:hidden">{archiveSize(run.sizeBytes)}</span>
            ) : null}
            <RelativeTime date={run.startedAt} className={cn("shrink-0", reason && "max-sm:hidden")} />
          </span>
        }
        metrics={
          took || test.kind === "verified" ? (
            <>
              {took && <span>took {took}</span>}
              {test.kind === "verified" && <span>restore verified</span>}
            </>
          ) : undefined
        }
        selected={selectedId === run.id}
        onOpen={() => setRun(selectedId === run.id ? null : run.id)}
      />
    );
  };

  return (
    <>
      <div ref={listRef} role="tree" aria-label="Backup jobs" data-healthy="quiet" onKeyDown={onRowKeys} className="grid grid-cols-1 gap-1">
        {sections.length === 0 && empty}
        {sections.map(({ job, runs }) => {
          const open = !collapsed.has(job.id);
          const last = latestFinished(job);
          const overdue = isJobOverdue(job, now);
          const size = storedBytes[job.id] ?? 0;
          const live = progress[job.id];
          return (
            <div key={job.id} id={jobAnchor(job.id)} role="none" className={cn("grid grid-cols-1 scroll-mt-28", open && "mt-1.5 mb-3.5")}>
              <SectionHeader
                navKey={`job:${job.id}`}
                title={job.name}
                href={`#${jobAnchor(job.id)}`}
                badge={!job.enabled ? <span className="text-[13px] text-muted-foreground">paused</span> : undefined}
                expanded={open}
                onToggle={() => toggle(job.id)}
              >
                {live ? (
                  <SectionNumber tone="text-status-info">backing up now</SectionNumber>
                ) : (
                  <SectionNumber tone={last?.status === "failed" ? "text-status-error" : undefined}>
                    {last ? (
                      <span>
                        {last.status === "failed" ? "last run failed " : last.status === "skipped" ? "last run skipped " : "last run "}
                        <RelativeTime date={last.startedAt} className="font-medium tabular-nums" />
                      </span>
                    ) : (
                      "never run"
                    )}
                  </SectionNumber>
                )}
                {overdue && <SectionNumber tone="text-status-warning">overdue</SectionNumber>}
                {job.enabled && (
                  <SectionNumber optional>
                    <NextRunText schedule={job.schedule} timeZone={job.nightly ? job.timeZone : undefined} />
                  </SectionNumber>
                )}
                <SectionNumber optional title="Archives in storage">
                  {size > 0 ? formatBytes(size) : "nothing stored"}
                </SectionNumber>
              </SectionHeader>
              {open && (
                <Card variant="surface" role="group" className="mt-0.5 grid grid-cols-1 gap-1 p-1.5">
                  <JobMeta job={job} orgId={orgId} readOnly={readOnly(job)} showApps={showApps} progress={live} onRefresh={onRefresh} canManage={can("backup.jobs.manage")} />
                  {runs.length === 0 ? (
                    <p className="px-3 py-2.5 pl-[38px] text-[13px] text-muted-foreground">No runs yet.</p>
                  ) : (
                    runs.map((r) => row(r, job.id))
                  )}
                </Card>
              )}
            </div>
          );
        })}
        {orphanRuns.length > 0 && (
          <div role="none" className="mt-1.5 grid grid-cols-1">
            <h3 className="px-1.5 py-2 text-[13px] font-semibold text-muted-foreground">Runs from deleted jobs</h3>
            <Card variant="surface" role="group" className="grid grid-cols-1 p-1.5">
              {orphanRuns.map((r) => row(r, null))}
            </Card>
          </div>
        )}
      </div>

      <DetailPanel
        open={!!selected}
        onClose={close}
        label={selected ? `Backup of ${selected.app?.displayName ?? selected.appName ?? "an app"}` : "Backup"}
        eyebrow={
          selected ? (
            <div className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground">
              <StatusDot tone={runMark(selected.status).tone} pending={runMark(selected.status).pending} className="text-[12.5px]">
                {runMark(selected.status).label}
              </StatusDot>
              <span aria-hidden="true">·</span>
              <RelativeTime date={selected.startedAt} />
            </div>
          ) : undefined
        }
        title={
          selected?.app ? (
            <EntityLink href={appHref(selected.app.name, "backups")}>{selected.app.displayName}</EntityLink>
          ) : (
            selected?.appName ?? "Deleted app"
          )
        }
      >
        {selected && <RunDetail run={selected} orgId={orgId} actions={actions} />}
      </DetailPanel>

      {actions.dialogs}
    </>
  );
}

function RunDetail({ run, orgId, actions }: { run: RecentBackup; orgId: string; actions: ReturnType<typeof useBackupActions> }) {
  const can = useCan();
  const reason = run.status === "failed" || run.status === "skipped" ? failureReason(run.log) : null;
  const took = runDuration(run);
  const canRestore = !!run.storagePath && !!run.app && can("backup.restore");
  const canDownload = !!run.storagePath && can("backup.download");
  const canDelete = can("backup.delete") && run.status !== "pending" && run.status !== "running";
  return (
    <div data-healthy="quiet" className="grid gap-5">
      {reason && <p className={cn("text-sm [overflow-wrap:anywhere]", run.status === "failed" ? "text-status-error" : "text-status-warning")}>{reason}</p>}
      {(canRestore || canDownload || canDelete) && (
        <div className="flex flex-wrap gap-2">
          {canRestore && (
            <Button size="sm" variant="outline" disabled={actions.restoring.has(run.id)} onClick={() => actions.askRestore(run)}>
              {actions.restoring.has(run.id) ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
              Restore
            </Button>
          )}
          {canDownload && (
            <Button size="sm" variant="outline" title={DOWNLOAD_HINT} asChild>
              <a href={`/api/v1/organizations/${orgId}/backups/history/${run.id}/download`}>
                <Download className="size-3.5" />
                Download
              </a>
            </Button>
          )}
          {canDelete && (
            <Button size="sm" variant="ghost" onClick={() => actions.askDelete(run)}>
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          )}
        </div>
      )}
      <PanelSection title="Details">
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-muted-foreground">Job</dt>
          <dd className="min-w-0">
            {run.job ? <EntityLink href={`#${jobAnchor(run.job.id)}`}>{run.job.name}</EntityLink> : `${run.jobName ?? "Unknown job"} (deleted)`}
          </dd>
          {run.volumeName && (
            <>
              <dt className="text-muted-foreground">Volume</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere]">{run.volumeName}</dd>
            </>
          )}
          {run.trigger && TRIGGER_LABELS[run.trigger] && (
            <>
              <dt className="text-muted-foreground">Started by</dt>
              <dd>{TRIGGER_LABELS[run.trigger]}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Started</dt>
          <dd>
            <RelativeTime date={run.startedAt} absoluteFirst />
          </dd>
          {took && (
            <>
              <dt className="text-muted-foreground">Took</dt>
              <dd>{took}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Size</dt>
          <dd>{archiveSize(run.sizeBytes)}</dd>
          <dt className="text-muted-foreground">Restore test</dt>
          <dd className="text-xs">
            <RestoreTestBadge test={restoreTestFor(run)} />
          </dd>
        </dl>
      </PanelSection>
      {run.log && (
        <PanelSection title="Log">
          <pre className="max-h-[50vh] overflow-auto rounded-lg bg-background p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {run.log}
          </pre>
        </PanelSection>
      )}
    </div>
  );
}

/** Schedule, target, retention, apps and the job's own actions, above its runs. */
function JobMeta({
  job,
  orgId,
  readOnly,
  showApps,
  progress,
  onRefresh,
  canManage,
}: {
  job: BackupJob;
  orgId: string;
  readOnly: boolean;
  showApps: boolean;
  progress?: RunProgress;
  onRefresh: () => void;
  canManage: boolean;
}) {
  const [running, setRunning] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const uncaptured = uncapturedSources(job.backupJobApps.map((bja) => bja.app));

  async function runNow() {
    setRunning(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups/jobs/${job.id}/run`, { method: "POST" });
      if (res.ok) {
        toast.success("Backup started");
        onRefresh();
      } else {
        toast.error("Couldn't start backup");
      }
    } catch {
      toast.error("Couldn't start backup");
    } finally {
      setRunning(false);
    }
  }

  async function toggleEnabled() {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !job.enabled }),
      });
      if (res.ok) {
        toast.success(job.enabled ? "Job paused" : "Job enabled");
        onRefresh();
      }
    } catch {
      toast.error("Couldn't update job");
    }
  }

  async function deleteJob() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups/jobs/${job.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Job deleted");
        setDeleteOpen(false);
        onRefresh();
      } else {
        toast.error("Couldn't delete job");
      }
    } catch {
      toast.error("Couldn't delete job");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div role="none" className="grid gap-2 px-3 pt-1.5 pb-2 pl-[38px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground">
        <span>
          {job.nightly
            ? `Nightly run · ${describeSchedule(job.schedule).toLowerCase()} ${(job.timeZone ?? "UTC").replace(/_/g, " ")}`
            : scheduleLabel(job.schedule)}
        </span>
        <span>to {job.target.name}</span>
        <RetentionSummary job={job} />
        {showApps && job.backupJobApps.length > 0 && (
          <span className="flex flex-wrap gap-x-1.5">
            {job.backupJobApps.map((bja, i) => (
              <span key={bja.app.id}>
                <EntityLink href={appHref(bja.app.name, "backups")} className={quietLinkClass}>
                  {bja.app.displayName}
                </EntityLink>
                {i < job.backupJobApps.length - 1 && ","}
              </span>
            ))}
          </span>
        )}
        {!readOnly && (
          <span className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={running || !!progress} onClick={runNow}>
              {running || progress ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Play className="size-3" aria-hidden="true" />}
              Run now
            </Button>
            {canManage && (
              <>
                <Button size="icon-xs" variant="ghost" onClick={toggleEnabled} aria-label={job.enabled ? "Pause job" : "Enable job"} title={job.enabled ? "Pause job" : "Enable job"}>
                  {job.enabled ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
                </Button>
                <Button size="icon-xs" variant="ghost" onClick={() => setDeleteOpen(true)} aria-label="Delete job" title="Delete job">
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            )}
          </span>
        )}
      </div>
      {progress && <RunProgressLine progress={progress} />}
      <UncapturedWarning sources={uncaptured} />
      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete backup job"
        description="Scheduled backups stop. Its backup history stays listed and downloadable."
        onConfirm={deleteJob}
        loading={deleting}
      />
    </div>
  );
}
