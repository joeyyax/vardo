"use client";

import { CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { describeSchedule } from "@/lib/cron/describe";
import { quietLinkClass } from "@/components/entity-link";

export type CronHeaderRow = { name: string; value: string };

export type CronJob = {
  id: string;
  organizationId: string;
  appId: string | null;
  name: string;
  type: "command" | "url";
  schedule: string;
  /** Null runs in the server's zone. */
  timeZone: string | null;
  command: string;
  method: string;
  headers: CronHeaderRow[];
  timeoutMs: number;
  retries: number;
  expectedStatus: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | "running" | null;
  lastLog: string | null;
  createdAt: string;
  app?: { id: string; name: string; displayName: string | null; projectId?: string | null } | null;
};

export type CronRun = {
  id: string;
  status: "success" | "failed" | "running";
  startedAt: string;
  completedAt: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  attempts: number | null;
  output: string | null;
  error: string | null;
};

export const SCHEDULE_PRESETS = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 10 minutes", value: "*/10 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Daily at 3 AM", value: "0 3 * * *" },
  { label: "Weekly (Sunday midnight)", value: "0 0 * * 0" },
  { label: "Custom", value: "custom" },
] as const;

export function scheduleLabel(cron: string): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.value === cron);
  if (preset) return preset.label;
  const described = describeSchedule(cron);
  return described.charAt(0).toUpperCase() + described.slice(1);
}

/** The schedule with the zone it runs in. */
export function scheduleWithZone(job: Pick<CronJob, "schedule" | "timeZone">): string {
  return job.timeZone ? `${scheduleLabel(job.schedule)} (${job.timeZone.replace(/_/g, " ")})` : scheduleLabel(job.schedule);
}

export function CronStatusIcon({ status }: { status: CronJob["lastStatus"] }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="size-4 text-status-success" aria-label="Last run succeeded" />;
    case "failed":
      return <XCircle className="size-4 text-status-error" aria-label="Last run failed" />;
    case "running":
      return <Loader2 className="size-4 text-status-info animate-spin" aria-label="Running" />;
    default:
      return <Clock className="size-4 text-muted-foreground" aria-label="Not run yet" />;
  }
}

/** "GET, 2 retries, 30s timeout" for a URL job. Empty for defaults. */
export function urlOptionsSummary(job: Pick<CronJob, "method" | "retries" | "timeoutMs" | "expectedStatus" | "headers">): string {
  const parts: string[] = [];
  if (job.method && job.method !== "GET") parts.push(job.method);
  if (job.retries > 0) parts.push(`${job.retries} ${job.retries === 1 ? "retry" : "retries"}`);
  if (job.timeoutMs && job.timeoutMs !== 30_000) parts.push(`${Math.round(job.timeoutMs / 1000)}s timeout`);
  if (job.expectedStatus) parts.push(`expects ${job.expectedStatus}`);
  if (job.headers?.length) parts.push(`${job.headers.length} ${job.headers.length === 1 ? "header" : "headers"}`);
  return parts.join(", ");
}

/** The element id of a cron job's card, for `#cron-<id>` links. */
export function cronAnchor(jobId: string): string {
  return `cron-${jobId}`;
}

/** A job's command; an absolute URL job opens its URL in a new tab. */
export function CronCommand({ job }: { job: Pick<CronJob, "type" | "command"> }) {
  if (job.type === "url" && /^https?:\/\//i.test(job.command)) {
    return (
      <a href={job.command} target="_blank" rel="noopener noreferrer" className={quietLinkClass}>
        {job.command}
      </a>
    );
  }
  return <>{job.command}</>;
}
