// Notification email subjects: the state first, then the subject, then one key detail.

import type { BusEvent } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { formatDuration, shortSha } from "./format";
import type { MailSeries } from "./templates/context";

export type SubjectContext = { instanceName: string; series?: MailSeries };

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
    case "backup.summary": {
      const failed = event.rows.filter((r) => r.outcome === "failed");
      if (failed.length) {
        const total = event.succeeded + event.failed + event.skipped;
        return event.failed === failed.length && total > 0
          ? `✗ Backups · ${event.failed} of ${total} failed`
          : `✗ Backups · ${failed.length} failed`;
      }
      const shrunk = event.rows.filter((r) => r.shrunk);
      if (shrunk.length) return `⚠ Backups · ${shrunk[0].appName} much smaller than usual`;
      if (event.staleVolumes?.length) return `⚠ Backups · ${event.staleVolumes.length} with no success in 48 h`;
      return event.succeeded > 0
        ? `✓ Backups · ${event.succeeded} done · ${formatBytesIec(event.totalSize)}`
        : `✓ Backups · ${event.rows.length} finished`;
    }
    case "cron.failed":
      return `✗ Cron ${event.cronJobName} failed on ${event.projectName || "an app"}`;
    case "disk.write-alert":
      return `⚠ ${event.appName || event.containerName} wrote ${formatBytesIec(event.writtenBytes)} in ${event.window || "1h"}`;
    case "volume.drift":
      return `⚠ ${event.appName} volumes drifted · ${event.totalDrift} files`;
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
    case "alert.fired": {
      const [first] = event.alerts;
      const mark = event.alerts.some((a) => a.severity === "critical") ? "✗" : "⚠";
      const where = first.appId ? "" : ` on ${host}`;
      const more = event.alerts.length > 1 ? ` · ${event.alerts.length - 1} more` : "";
      return `${mark} ${first.title}${where}${more}`;
    }
    case "alert.resolved": {
      const [first] = event.alerts;
      return event.alerts.length === 1
        ? `✓ Resolved · ${first.title}${first.appId ? "" : ` on ${host}`}`
        : `✓ ${event.alerts.length} alerts resolved on ${host}`;
    }
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
    case "digest.health":
      return `${event.cadence === "daily" ? "Daily" : "Weekly"} summary · ${event.orgName} · ${event.windowLabel}`;
    default:
      return event.title;
  }
}
