import type { BackupJob } from "./types";

type RetentionFields = Pick<BackupJob, "keepLast" | "keepDaily" | "keepWeekly" | "keepMonthly">;

/** Compact format for job cards: "1 last, 7 daily, 1 weekly, 1 monthly" */
export function retentionText(job: RetentionFields): string {
  const parts: string[] = [];
  if (job.keepLast) parts.push(`${job.keepLast} last`);
  if (job.keepDaily) parts.push(`${job.keepDaily} daily`);
  if (job.keepWeekly) parts.push(`${job.keepWeekly} weekly`);
  if (job.keepMonthly) parts.push(`${job.keepMonthly} monthly`);
  if (parts.length === 0) return "No retention policy";
  return parts.join(", ");
}

/** Human-readable format for banners: "Keeps 7 days of snapshots, plus weekly and monthly archives" */
export function retentionDescription(job: RetentionFields): string {
  const parts: string[] = [];
  if (job.keepDaily) parts.push(`${job.keepDaily} days of snapshots`);
  if (job.keepWeekly) parts.push("weekly");
  if (job.keepMonthly) parts.push("monthly");

  if (parts.length === 0) return "No retention policy";
  if (parts.length === 1) return `Keeps ${parts[0]}`;

  const daily = parts.shift()!;
  return `Keeps ${daily}, plus ${parts.join(" and ")} archives`;
}

export function RetentionSummary({ job }: { job: RetentionFields }) {
  return <span className="text-muted-foreground">{retentionText(job)}</span>;
}
