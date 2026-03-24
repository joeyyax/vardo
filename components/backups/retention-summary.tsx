import type { BackupJob } from "./types";

type RetentionFields = Pick<BackupJob, "keepLast" | "keepDaily" | "keepWeekly" | "keepMonthly">;

export function retentionText(job: RetentionFields): string {
  const parts: string[] = [];
  if (job.keepLast) parts.push(`${job.keepLast} last`);
  if (job.keepDaily) parts.push(`${job.keepDaily} daily`);
  if (job.keepWeekly) parts.push(`${job.keepWeekly} weekly`);
  if (job.keepMonthly) parts.push(`${job.keepMonthly} monthly`);
  if (parts.length === 0) return "No retention policy";
  return parts.join(", ");
}

export function RetentionSummary({ job }: { job: RetentionFields }) {
  return <span className="text-muted-foreground">{retentionText(job)}</span>;
}
