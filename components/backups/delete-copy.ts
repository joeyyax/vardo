import { formatBytes } from "@/lib/metrics/format";
import type { RecentBackup, TargetUsage } from "./types";

export function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** What goes with the target, for the confirmation. */
export function usageSummary(usage: TargetUsage, appLevel: boolean) {
  const parts: string[] = [];
  if (usage.backups > 0) {
    parts.push(`${plural(usage.backups, "backup")} with their ${formatBytes(usage.bytes)} of archives in storage`);
  }
  if (usage.jobs > 0) {
    const names = usage.jobNames.length > 0 ? `: ${usage.jobNames.join(", ")}` : "";
    parts.push(`${plural(usage.jobs, "backup job")}${names}`);
  }
  const scope = appLevel ? " across every organization" : "";
  return `Also deletes ${parts.join(", and ")}${scope}. This can't be undone.`;
}

/** A deleted app's or job's history, which can go in one step. */
export function orphanScope(backup: RecentBackup) {
  if (!backup.app && backup.appId) {
    return { query: `appId=${encodeURIComponent(backup.appId)}`, label: backup.appName ?? "this deleted app" };
  }
  if (!backup.job && backup.jobName) {
    return { query: `jobName=${encodeURIComponent(backup.jobName)}`, label: `the deleted job ${backup.jobName}` };
  }
  return null;
}

export function deleteDescription(backup: RecentBackup) {
  const what = backup.app?.displayName ?? backup.appName ?? "this app";
  const when = new Date(backup.startedAt).toLocaleString();
  const archive =
    backup.storagePath && backup.status !== "pruned"
      ? ` and its archive${backup.sizeBytes ? ` (${formatBytes(backup.sizeBytes)})` : ""} from storage`
      : "";
  return `Deletes the ${when} backup of ${what}${archive}. This can't be undone.`;
}
