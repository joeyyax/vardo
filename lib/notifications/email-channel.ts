import { createElement } from "react";
import type { NotificationChannel } from "./port";
import type { BusEvent } from "@/lib/bus/events";
import { sendEmail } from "@/lib/email/send";
import { logger } from "@/lib/logger";

const log = logger.child("notifications");
import { DeploySuccessEmail } from "@/lib/email/templates/deploy-success";
import { DeployFailedEmail } from "@/lib/email/templates/deploy-failed";
import { BackupSuccessEmail } from "@/lib/email/templates/backup-success";
import { BackupFailedEmail } from "@/lib/email/templates/backup-failed";
import { CronFailedEmail } from "@/lib/email/templates/cron-failed";
import { DiskWriteAlertEmail } from "@/lib/email/templates/disk-write-alert";
import { VolumeDriftEmail } from "@/lib/email/templates/volume-drift";
import { AutoRollbackEmail } from "@/lib/email/templates/auto-rollback";
import { SystemAlertEmail } from "@/lib/email/templates/system-alert";
import { WeeklyDigestEmail } from "@/lib/email/templates/weekly-digest";

type EmailConfig = { recipients: string[] };

export class EmailNotificationChannel implements NotificationChannel {
  constructor(private config: EmailConfig) {}

  async send(event: BusEvent): Promise<void> {
    for (const recipient of this.config.recipients) {
      try {
        const template = this.buildTemplate(event);
        if (template) {
          await sendEmail({ to: recipient, subject: event.title, template });
        }
      } catch (err) {
        log.error(
          `Failed to send email to ${recipient}:`,
          err,
        );
      }
    }
  }

  private buildTemplate(event: BusEvent) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const dashboardUrl = "appId" in event && event.appId
      ? `${appUrl}/projects/${event.appId}`
      : appUrl;

    switch (event.type) {
      case "deploy.success":
        return DeploySuccessEmail({
          projectName: event.projectName || "Unknown",
          deploymentId: event.deploymentId || "",
          domain: event.domain,
          duration: event.duration || "unknown",
          gitSha: event.gitSha,
          gitMessage: event.gitMessage,
          triggeredBy: event.triggeredBy,
          dashboardUrl,
        });

      case "deploy.failed":
        return DeployFailedEmail({
          projectName: event.projectName || "Unknown",
          deploymentId: event.deploymentId || "",
          errorMessage: event.errorMessage,
          gitSha: event.gitSha,
          gitMessage: event.gitMessage,
          triggeredBy: event.triggeredBy,
          dashboardUrl,
        });

      case "backup.success":
        return BackupSuccessEmail({
          appName: event.jobName || "Unknown",
          volumeNames: [],
          totalSize: String(event.totalSize) || "unknown",
          duration: "unknown",
          dashboardUrl,
        });

      case "backup.failed":
        return BackupFailedEmail({
          appName: event.jobName || "Unknown",
          errorMessage: event.errors || event.message,
          dashboardUrl,
        });

      case "cron.failed":
        return CronFailedEmail({
          jobName: event.cronJobName || "Unknown job",
          appName: event.projectName || "Unknown",
          command: "",
          duration: String(event.durationMs),
          dashboardUrl,
        });

      case "disk.write-alert":
        return DiskWriteAlertEmail({
          appName: event.containerName || "Unknown",
          containerName: event.containerName,
          writeAmount: String(event.writtenBytes) || "unknown",
          threshold: String(event.thresholdBytes) || "unknown",
          period: event.window,
          dashboardUrl,
        });

      case "volume.drift":
        return VolumeDriftEmail({
          appName: event.appName || "Unknown",
          volumeName: "unknown",
          modifiedCount: 0,
          addedCount: 0,
          missingCount: 0,
          dashboardUrl,
        });

      case "deploy.rollback":
        return AutoRollbackEmail({
          appName: event.projectName || "Unknown",
          reason: event.rollbackSuccess
            ? "Automatic rollback succeeded"
            : "Automatic rollback failed",
          fromDeploymentId: "",
          toDeploymentId: "",
          dashboardUrl,
        });

      case "system.service-down":
      case "system.disk-alert":
      case "system.restart-loop":
      case "system.cert-expiring":
      case "system.update-available":
        return SystemAlertEmail({
          alertType: event.type,
          title: event.title,
          message: event.message,
          details: flattenToStrings(event),
          dashboardUrl: appUrl,
        });

      case "digest.weekly":
        return WeeklyDigestEmail({
          orgName: event.orgName || "Your Organization",
          weekLabel: event.weekLabel || "",
          deploys: {
            total: event.deploysTotal,
            succeeded: event.deploysSucceeded,
            failed: event.deploysFailed,
          },
          backups: {
            total: event.backupsTotal,
            succeeded: 0,
            failed: event.backupsFailed,
          },
          cron: {
            totalFailures: event.cronFailed,
            affectedJobs: [],
          },
          alerts: {
            diskWriteAlerts: 0,
            volumeDrifts: 0,
          },
          projects: [],
          dashboardUrl,
        });

      default:
        return createElement(
          "div",
          {
            style: {
              fontFamily: "sans-serif",
              padding: "20px",
              maxWidth: "600px",
            },
          },
          createElement(
            "h2",
            { style: { margin: "0 0 12px" } },
            event.title,
          ),
          createElement(
            "p",
            {
              style: { color: "#374151", whiteSpace: "pre-wrap" },
            },
            event.message,
          ),
          createElement("hr", {
            style: {
              border: "none",
              borderTop: "1px solid #e5e7eb",
              margin: "20px 0",
            },
          }),
          createElement(
            "a",
            { href: dashboardUrl, style: { color: "#6366f1" } },
            "View Dashboard",
          ),
        );
    }
  }
}

/** Flatten a BusEvent extra fields to Record<string, string> for templates that need it. */
function flattenToStrings(event: BusEvent): Record<string, string> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { type: _type, title: _title, message: _message, ...rest } = event;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined && value !== null) {
      result[key] = String(value);
    }
  }
  return result;
}
