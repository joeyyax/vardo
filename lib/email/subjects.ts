// Notification email subjects: the state first, then the subject, then one key detail.

import type { BusEvent } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { formatDuration, shortSha } from "./format";

export type SubjectContext = { instanceName: string };

/** Display name for an app-scoped event. Never "Unknown". */
export function appLabel(event: { projectName?: string; appName?: string; project?: string }): string {
  return event.projectName?.trim() || event.appName?.trim() || event.project?.trim() || "an app";
}

const STAGE_LABELS: Record<string, string> = {
  queued: "queue",
  clone: "clone",
  build: "build",
  deploy: "start",
  healthcheck: "health check",
  routing: "routing",
  cleanup: "cleanup",
  done: "finish",
};

export function stageLabel(stage: string | undefined): string | undefined {
  if (!stage) return undefined;
  return STAGE_LABELS[stage] ?? stage;
}

function withSha(text: string, sha: string | undefined): string {
  return sha ? `${text} · ${shortSha(sha)}` : text;
}

export function notificationSubject(event: BusEvent, ctx: SubjectContext): string {
  const host = ctx.instanceName;
  switch (event.type) {
    case "deploy.success":
      return withSha(`✓ ${appLabel(event)} deployed`, event.gitSha);
    case "deploy.failed": {
      const stage = stageLabel(event.failedStage);
      return `✗ ${appLabel(event)} failed${stage ? ` at ${stage}` : ""}`;
    }
    case "deploy.incomplete":
      return `⚠ ${appLabel(event)} deployed, post-deploy work unfinished`;
    case "deploy.rollback":
      return event.rollbackSuccess
        ? `↩ ${appLabel(event)} rolled back${event.restoredSlot ? ` to ${event.restoredSlot}` : ""}`
        : `✗ ${appLabel(event)} rollback failed`;
    case "backup.success":
      return `✓ Backup ${event.jobName} · ${formatBytesIec(event.totalSize)}`;
    case "backup.failed":
      return `✗ Backup ${event.jobName} failed · ${event.failedCount} of ${event.totalCount}`;
    case "cron.failed":
      return `✗ Cron ${event.cronJobName} failed on ${event.projectName || "an app"}`;
    case "disk.write-alert":
      return `⚠ ${event.appName || event.containerName} wrote ${formatBytesIec(event.writtenBytes)} in ${event.window || "1h"}`;
    case "volume.drift":
      return `⚠ ${event.appName} volumes drifted · ${event.totalDrift} files`;
    case "system.disk-alert":
      return `${event.severity === "critical" ? "✗" : "⚠"} Disk ${Math.round(event.percent)}% on ${host}`;
    case "system.service-down":
      return `✗ ${event.service} down on ${host}`;
    case "system.restart-loop":
      return `⚠ Vardo restarted on ${host}`;
    case "system.cert-expiring":
      return event.daysLeft <= 0
        ? `✗ Certificate expired · ${event.domain}`
        : `⚠ Certificate expires in ${event.daysLeft} d · ${event.domain}`;
    case "system.update-available":
      return `↑ Vardo update available on ${host}`;
    case "app.oom-killed":
      return `✗ ${event.appName} killed for memory`;
    case "app.auto-restarted":
      return event.gaveUp ? `✗ ${event.appName} keeps failing, restarts stopped` : `⚠ ${event.appName} restarted`;
    case "system.shutdown":
      return `↓ Vardo shutting down on ${host}`;
    case "system.started":
      return event.downSeconds !== undefined
        ? `✓ Vardo back on ${host} after ${formatDuration(event.downSeconds * 1000)}`
        : `✓ Vardo started on ${host}`;
    case "system.recovered-unclean":
      return `⚠ Vardo recovered on ${host} after an unclean stop`;
    case "system.update-started":
      return `↑ Vardo updating on ${host} · ${event.fromVersion}`;
    case "system.updated":
      return `✓ Vardo updated on ${host} · ${event.fromVersion} → ${event.toVersion}`;
    case "system.update-failed":
      return `✗ Vardo update failed on ${host} at ${event.step}`;
    case "system.containers-missing":
      return `⚠ ${event.containers.length} container${event.containers.length === 1 ? "" : "s"} didn't come back on ${host}`;
    case "digest.weekly":
      return `Weekly digest · ${event.orgName} · ${event.weekLabel}`;
    default:
      return event.title;
  }
}
