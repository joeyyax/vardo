// Notification email subjects: the instance, then the state, the subject and one key detail.

import type { AlertResolvedEvent, BusEvent, MissingContainer } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { backupRunTotal, formatDuration, formatDurationRough, plural, shortSha, stackedName, versionShort, windowPhrase } from "./format";
import { appRecapSubject } from "./templates/app-recap";
import { digestSubject } from "./templates/digest";
import { backupProblemCount } from "./templates/backup";
import type { MailSeries } from "./templates/context";

export type SubjectContext = { instanceName: string; series?: MailSeries };

/** Display name for an app-scoped event. Never "Unknown". */
export function appLabel(event: { projectName?: string; appName?: string; project?: string }): string {
  return event.projectName?.trim() || event.appName?.trim() || event.project?.trim() || "an app";
}

const STAGE_LABELS: Record<string, string> = {
  queued: "queue",
  clone: "prepare",
  compose: "prepare",
  build: "build",
  deploy: "start",
  healthcheck: "health check",
  routing: "switch traffic",
  cleanup: "cleanup",
  done: "finish",
};

export function stageLabel(stage: string | undefined): string | undefined {
  if (!stage) return undefined;
  return STAGE_LABELS[stage] ?? stage;
}

/** Post-deploy work that left the previous version running. */
export function oldVersionStillRunning(reason: string): boolean {
  return /^the old slot \(\w+\) is still running\b/.test(reason);
}

function withSha(text: string, sha: string | undefined): string {
  return sha ? `${text} · ${shortSha(sha)}` : text;
}

function rolloutInstances(members: { name: string; priority: "critical" | "standard" | "low" }[]): string {
  if (!members.length) return "your instances";
  if (members.length > 2) return `${members.length} instances`;
  const rank = { critical: 0, standard: 1, low: 2 };
  return [...members].sort((a, b) => rank[a.priority] - rank[b.priority] || a.name.localeCompare(b.name)).map((member) => member.name).join(" and ");
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "2 apps" when every container has an app, "3 containers" otherwise. */
export function missingLabel(containers: MissingContainer[]): string {
  return containers.every((c) => c.app)
    ? plural(new Set(containers.map((c) => c.app)).size, "app")
    : plural(containers.length, "container");
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
      const text = `✗ ${appLabel(event)} failed${stage ? ` at ${stage}` : ""}`;
      if (event.gitSha && (event.failedStage === "build" || event.failedStage === "clone")) return withSha(text, event.gitSha);
      return event.serving === "previous" ? `${text} · still serving the previous version` : text;
    }
    case "deploy.incomplete":
      return oldVersionStillRunning(event.reason)
        ? `⚠ ${appLabel(event)} is live · the old version is still running`
        : `⚠ ${appLabel(event)} is live · cleanup didn't finish`;
    case "deploy.rollback":
      return event.rollbackSuccess ? `↩ ${appLabel(event)} rolled back to the previous version` : `✗ ${appLabel(event)} rollback failed`;
    case "backup.summary": {
      const label = event.run.label;
      const failed = event.rows.filter((r) => r.outcome === "failed");
      const problems = backupProblemCount(event);
      if (problems > failed.length && problems > 1) return `${failed.length ? "✗" : "⚠"} ${label} · ${problems} need you`;
      if (failed.length) {
        const total = backupRunTotal(event);
        return event.failed === failed.length && total > 0
          ? `✗ ${label} · ${event.failed} of ${total} failed`
          : `✗ ${label} · ${failed.length} failed`;
      }
      const timedOut = event.run.unfinished?.length ?? 0;
      if (timedOut) {
        const allUnstarted = (event.run.notStarted?.length ?? 0) === timedOut;
        return `⚠ ${label} · timed out, ${timedOut} didn't ${allUnstarted ? "start" : "finish"}`;
      }
      const shrunk = event.rows.filter((r) => r.shrunk);
      if (shrunk.length) return `⚠ ${label} · ${shrunk[0].appName} much smaller than usual`;
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
      return `⚠ ${stackedName(event.appName || event.containerName, event.projectName)} wrote ${formatBytesIec(event.writtenBytes)} in ${windowPhrase(event.window)}`;
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
      return event.subject ? `✗ ${event.subject}` : `✗ ${event.service} down`;
    case "system.restart-loop":
      return "⚠ Vardo restarted";
    case "system.cert-expiring":
      return event.daysLeft <= 0
        ? `✗ Certificate expired · ${event.domain}`
        : `⚠ Certificate expires in ${event.daysLeft} d · ${event.domain}`;
    case "system.integration-permissions":
      return `⚠ ${event.title}`;
    case "system.update-available": {
      const detail = event.target ?? (event.commitsBehind ? plural(event.commitsBehind, "commit") : undefined);
      return `↑ Vardo update available${detail ? ` · ${detail}` : ""}`;
    }
    case "alert.fired": {
      const [first] = event.alerts;
      const mark = event.alerts.some((a) => a.severity === "critical") ? "✗" : "⚠";
      if (event.alerts.length === 1 && first.incident) return `${mark} ${first.incident.title}`;
      const more = event.alerts.length > 1 ? ` · ${event.alerts.length - 1} more` : "";
      return `${mark} ${first.title}${more}`;
    }
    case "alert.resolved": {
      const [first] = event.alerts;
      if (event.alerts.length > 1) return `✓ ${event.alerts.length} alerts resolved`;
      return first.type === "cron.failure" ? cronRecovered(first) : `✓ Resolved · ${first.incident?.title ?? first.title}`;
    }
    case "app.auto-restarted":
      return event.gaveUp ? `✗ ${event.appName} keeps failing, restarts stopped` : `⚠ ${event.appName} restarted`;
    case "system.shutdown":
      return "↓ Vardo stopping";
    case "system.started": {
      const after = event.downSeconds !== undefined ? ` after ${formatDurationRough(event.downSeconds * 1000)}` : "";
      return event.containers?.length ? `⚠ Vardo back up${after} · ${missingLabel(event.containers)} didn't come back` : `✓ Vardo back up${after}`;
    }
    case "system.recovered-unclean":
      return `⚠ Vardo stopped unexpectedly${event.containers?.length ? ` · ${missingLabel(event.containers)} didn't come back` : ""}`;
    case "system.update-started":
      return "↑ Vardo update started";
    case "system.updated":
      return `✓ Vardo updated · ${versionShort(event.toVersion)}`;
    case "system.update-failed":
      return `✗ Vardo update failed at ${event.step.charAt(0).toLowerCase()}${event.step.slice(1)}`;
    case "system.rollout-started":
      return `Vardo update started for ${rolloutInstances(event.members)}`;
    case "system.rollout-busy": {
      const busy = event.members.find((member) => member.instanceId === event.busyInstanceId);
      return `Vardo update waiting${busy ? ` for ${busy.name}` : ""}`;
    }
    case "system.rollout-paused":
      return `✗ Vardo update paused · ${event.targetLabel}`;
    case "system.rollout-finished": {
      const updated = event.members.filter((member) => member.state !== "skipped");
      return updated.length < event.members.length
        ? `⚠ Vardo updated on ${updated.length} of ${plural(event.members.length, "instance")} · ${event.targetLabel}`
        : `✓ Vardo updated on ${rolloutInstances(event.members)} · ${event.targetLabel}`;
    }
    case "system.restarting":
      return `↻ Restarting ${event.label}`;
    case "system.restarted":
      return event.target === "services" ? `✓ Restarted ${event.label}` : `✓ ${capitalize(event.label)} back up`;
    case "system.restart-failed":
      return `✗ ${capitalize(event.label)} didn't come back`;
    case "system.containers-missing":
      return `⚠ ${missingLabel(event.containers)} didn't come back`;
    case "digest.health":
      return digestSubject(event);
    case "digest.app-recap":
      return appRecapSubject(event);
    default:
      return event.title;
  }
}

/** "node-a · ✓ Shop deployed · 4d75067": the instance first, so one name leads every email. */
export function notificationSubject(event: BusEvent, ctx: SubjectContext): string {
  const line = subjectLine(event);
  if (event.type.startsWith("system.rollout-")) return line;
  const instance = ctx.instanceName.trim();
  return instance ? `${instance} · ${line}` : line;
}
