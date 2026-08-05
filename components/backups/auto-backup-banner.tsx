"use client";

import { ShieldCheck, AlertTriangle, Info, CloudUpload, HardDrive, Loader2 } from "lucide-react";
import { retentionDescription } from "./retention-summary";
import { describeSchedule } from "./schedule-summary";
import { RunProgressLine } from "./run-progress";
import type { BackupJob, BackupTarget, RecentBackup, RunProgress } from "./types";

/** Anything not on this host leaves with the host if it dies. */
const OFFSITE_TYPES = new Set(["s3", "r2", "b2", "ssh"]);

export function AutoBackupBanner({
  target,
  jobs,
  recent = [],
  running = [],
}: {
  target: BackupTarget;
  jobs: BackupJob[];
  /** Recent runs for this target, newest first. */
  recent?: RecentBackup[];
  /** Runs in flight right now, one entry per job. */
  running?: RunProgress[];
}) {
  const retention = jobs.length > 0 ? retentionDescription(jobs[0]) : "Default retention";
  const schedule = jobs.length > 0 ? describeSchedule(jobs[0].schedule) : "No schedule";
  const offsite = OFFSITE_TYPES.has(target.type);

  const failures = recent.filter((r) => r.status === "failed");
  // The attention bar counts apps, this counts runs — say both so they reconcile.
  const failedApps = new Set(failures.map((r) => r.app.displayName)).size;
  const lastRun = recent[0];
  const healthy = failures.length === 0 && lastRun?.status === "success";

  return (
    <div className="squircle space-y-4 rounded-lg bg-card p-5 shadow-card dark:border">
      <div className="flex items-start gap-3">
        {running.length > 0 ? (
          <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-status-warning" aria-hidden="true" />
        ) : healthy ? (
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-status-success" aria-hidden="true" />
        ) : (
          <AlertTriangle
            className={`mt-0.5 size-5 shrink-0 ${failures.length > 0 ? "text-status-error" : "text-status-warning"}`}
            aria-hidden="true"
          />
        )}
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {running.length > 0
              ? `Backing up now — ${running.length} job${running.length === 1 ? "" : "s"} in flight`
              : failures.length > 0
                ? `${failures.length} failed run${failures.length === 1 ? "" : "s"} across ${failedApps} app${failedApps === 1 ? "" : "s"}`
                : lastRun
                  ? "Automatic backups are running"
                  : "Automatic backups are configured"}
          </h3>
          <p className="text-sm text-muted-foreground">
            {running.length > 0
              ? "Snapshots appear in the history below as each one finishes."
              : failures.length > 0
                ? "Check the history below for the failing job. Earlier snapshots are still restorable."
                : lastRun
                  ? "You can download or restore any snapshot, or add your own targets for more redundancy."
                  : "Nothing has run yet. The first snapshot appears here after the next scheduled run."}
          </p>
          {running.length > 0 && (
            <div className="space-y-1 pt-1">
              {running.map((progress) => (
                <RunProgressLine key={progress.jobId} progress={progress} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pl-8 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Info className="size-3" aria-hidden="true" />
          {schedule}
        </span>
        <span className="flex items-center gap-1.5">
          {offsite ? (
            <CloudUpload className="size-3" aria-hidden="true" />
          ) : (
            <HardDrive className="size-3" aria-hidden="true" />
          )}
          {offsite ? `Offsite · ${target.name}` : `On this host · ${target.name}`}
        </span>
        <span className="flex items-center gap-1.5">
          <Info className="size-3" aria-hidden="true" />
          {retention}
        </span>
      </div>
    </div>
  );
}
