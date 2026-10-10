import { MIN_VALID_GZIP_BYTES } from "@/lib/backups/archive";
import { overdueBackupJobs } from "@/lib/backups/staleness";
import { formatBytes } from "@/lib/metrics/format";
import type { StatusMarkState } from "@/lib/ui/status-colors";
import type { BackupJob, JobRun, RecentBackup } from "./types";

const mark = (tone: StatusMarkState["tone"], label: string, pending = false): StatusMarkState => ({ tone, label, pending });

/** A run's mark. A good run is quiet; failures and skips carry color. Green is for liveness only. */
export function runMark(status: string): StatusMarkState {
  switch (status) {
    case "success":
      return mark("neutral", "Backed up");
    case "failed":
      return mark("issue", "Failed");
    case "skipped":
      return mark("warn", "Skipped");
    case "running":
      return mark("info", "Running", true);
    case "pending":
      return mark("neutral", "Waiting", true);
    default:
      return mark("neutral", status.charAt(0).toUpperCase() + status.slice(1));
  }
}

/** Enabled and behind its own schedule by the same rule as the attention bar. */
export function isJobOverdue(job: Pick<BackupJob, "id" | "name" | "schedule" | "enabled" | "lastRunAt" | "createdAt">, now: Date): boolean {
  return (
    overdueBackupJobs(
      [{ ...job, lastRunAt: job.lastRunAt ? new Date(job.lastRunAt) : null, createdAt: new Date(job.createdAt) }],
      now,
    ).length > 0
  );
}

/** The newest finished run, which says whether the job is healthy. */
export function latestFinished(job: Pick<BackupJob, "backups">): JobRun | null {
  return job.backups.find((b) => b.status !== "running" && b.status !== "pending") ?? null;
}

/** Healthy jobs start folded: last run good, not overdue, nothing running. */
export function jobNeedsLook(job: BackupJob, now: Date, running: boolean): boolean {
  if (running) return true;
  const last = latestFinished(job);
  return last?.status === "failed" || last?.status === "skipped" || isJobOverdue(job, now);
}

/** A run with its job attached, for the shared restore and delete flows. */
export function asRecent(job: Pick<BackupJob, "id" | "name">, run: JobRun): RecentBackup {
  return {
    storagePath: null,
    log: null,
    verifiedAt: null,
    verifyOutcome: null,
    verifyDetail: null,
    jobName: job.name,
    appId: null,
    app: null,
    appName: null,
    ...run,
    job: { id: job.id, name: job.name },
  };
}

/** An archive under the floor means the engine confirmed the source empty. */
export function archiveSize(sizeBytes: number | null): string {
  if (sizeBytes == null) return "—";
  if (sizeBytes < MIN_VALID_GZIP_BYTES) return "Empty";
  return formatBytes(sizeBytes);
}
