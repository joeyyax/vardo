// Notification email subjects: the instance, then the state, the subject and one key detail.

import type { AlertResolvedEvent, BusEvent } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { formatDuration, formatDurationRough, plural, shortSha, stackedName, truncate, versionShort } from "./format";
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

/** Commit subjects in a subject line are cut to this. */
const COMMIT_SUBJECT_MAX = 60;

function withSha(text: string, sha: string | undefined): string {
  return sha ? `${text} · ${shortSha(sha)}` : text;
}

function headSubject(commits: { subject: string }[] | undefined): string | undefined {
  const head = commits?.[0]?.subject;
  return head ? truncate(head, COMMIT_SUBJECT_MAX) : undefined;
}

/** "✓ WP Cron on Shop recovered after 4 min", for a single cleared cron alert. */
function cronRecovered(item: AlertResolvedEvent["alerts"][number]): string {
  const job = item.facts?.find((f) => f.label === "Job")?.value ?? item.title;
  const lasted = Date.parse(item.resolvedAt) - Date.parse(item.since ?? item.firedAt);
  const after = Number.isFinite(lasted) && lasted > 0 ? ` after ${formatDurationRough(lasted)}` : "";
  return `✓ ${job}${item.appName ? ` on ${item.appName}` : ""} recovered${after}`;
}

/** The subject without the instance prefix. */
export function subjectLine(event: BusEvent): string {
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
      const label = event.run.label;
      const failed = event.rows.filter((r) => r.outcome === "failed");
      if (failed.length) {
        const total = event.succeeded + event.failed + event.skipped;
        return event.failed === failed.length && total > 0
          ? `✗ ${label} · ${event.failed} of ${total} failed`
          : `✗ ${label} · ${failed.length} failed`;
      }
      if (event.run.unfinished?.length) return `⚠ ${label} · ${event.run.unfinished.length} didn't finish`;
      const shrunk = event.rows.filter((r) => r.shrunk);
      if (shrunk.length) return `⚠ ${label} · ${shrunk[0].appName} much smaller than usual`;
      const grew = event.rows.filter((r) => r.grew);
      if (grew.length) return `⚠ ${label} · ${grew[0].appName} much larger than last run`;
      const skipped = event.rows.filter((r) => r.outcome === "skipped" && !r.expected);
      if (skipped.length) return `⚠ ${label} · ${plural(skipped.length, "volume")} skipped`;
      if (event.staleVolumes?.length) return `⚠ ${label} · ${event.staleVolumes.length} with no success in 48 h`;
      return event.succeeded > 0
        ? `✓ ${label} · ${event.succeeded} done · ${formatBytesIec(event.totalSize)}`
        : `✓ ${label} · ${event.rows.length} finished`;
    }
    case "backup.run-started":
      return `↻ ${event.label} starting · ${plural(event.volumeCount, "volume")}${event.estimatedMs ? ` · ~${formatDuration(event.estimatedMs)}` : ""}`;
    case "cron.failed":
      return `✗ Cron ${event.cronJobName} failed on ${event.projectName || "an app"}`;
    case "disk.write-alert":
      return `⚠ ${stackedName(event.appName || event.containerName, event.projectName)} wrote ${formatBytesIec(event.writtenBytes)} in ${event.window || "1h"}`;
    case "volume.drift":
      return `⚠ ${event.appName} volumes drifted · ${event.totalDrift} files`;
    case "security.scan-findings": {
      const apps = event.apps ?? [];
      const findings = apps.reduce((n, a) => n + a.findings.length, 0);
      const mark = apps.some((a) => a.findings.some((f) => f.severity === "critical")) || event.criticalCount > 0 ? "✗" : "⚠";
      if (event.trigger === "manual") {
        return findings || event.criticalCount + event.warningCount
          ? `${mark} Security scan · ${event.appName} · ${plural(findings || event.criticalCount + event.warningCount, "finding")}`
          : `✓ Security scan · ${event.appName} · no issues`;
      }
      if (apps.length > 1) return `${mark} ${plural(findings, "new security finding")} on ${plural(apps.length, "app")}`;
      return `${mark} ${plural(findings || event.criticalCount + event.warningCount, "new security finding")} on ${event.appName}`;
    }
    case "system.service-down":
      return `✗ ${event.service} down`;
    case "system.restart-loop":
      return "⚠ Vardo restarted";
    case "system.cert-expiring":
      return event.daysLeft <= 0
        ? `✗ Certificate expired · ${event.domain}`
        : `⚠ Certificate expires in ${event.daysLeft} d · ${event.domain}`;
    case "system.integration-permissions":
      return `⚠ ${event.title}`;
    case "system.update-available":
      return [
        "↑ Vardo update",
        event.target,
        event.commitsBehind ? plural(event.commitsBehind, "commit") : undefined,
        headSubject(event.commits),
      ]
        .filter(Boolean)
        .join(" · ");
    case "alert.fired": {
      const [first] = event.alerts;
      const mark = event.alerts.some((a) => a.severity === "critical") ? "✗" : "⚠";
      const more = event.alerts.length > 1 ? ` · ${event.alerts.length - 1} more` : "";
      return `${mark} ${first.title}${more}`;
    }
    case "alert.resolved": {
      const [first] = event.alerts;
      if (event.alerts.length > 1) return `✓ ${event.alerts.length} alerts resolved`;
      return first.type === "cron.failure" ? cronRecovered(first) : `✓ Resolved · ${first.title}`;
    }
    case "app.auto-restarted":
      return event.gaveUp ? `✗ ${event.appName} keeps failing, restarts stopped` : `⚠ ${event.appName} restarted`;
    case "system.shutdown":
      return "↓ Vardo shutting down";
    case "system.started":
      return event.downSeconds !== undefined ? `✓ Vardo back after ${formatDuration(event.downSeconds * 1000)}` : "✓ Vardo started";
    case "system.recovered-unclean":
      return "⚠ Vardo recovered after an unclean stop";
    case "system.update-started":
      return `↑ Vardo updating · ${versionShort(event.fromVersion)}`;
    case "system.updated":
      return [`✓ Vardo updated · ${versionShort(event.fromVersion)} → ${versionShort(event.toVersion)}`, headSubject(event.commits)]
        .filter(Boolean)
        .join(" ");
    case "system.update-failed":
      return `✗ Vardo update failed at ${event.step}`;
    case "system.update-skipped":
      return `⚠ Vardo update skipped · ${event.target}`;
    case "system.containers-missing":
      return `⚠ ${plural(event.containers.length, "container")} didn't come back`;
    case "digest.health":
      return `${event.cadence === "daily" ? "Daily" : "Weekly"} summary · ${event.orgName} · ${event.windowLabel}`;
    default:
      return event.title;
  }
}

/** "node-a · ✓ Shop deployed · 4d75067": the instance first, so one name leads every email. */
export function notificationSubject(event: BusEvent, ctx: SubjectContext): string {
  const line = subjectLine(event);
  const instance = ctx.instanceName.trim();
  return instance ? `${instance} · ${line}` : line;
}
