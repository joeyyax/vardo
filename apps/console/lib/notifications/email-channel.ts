import { createElement } from "react";
import type { NotificationChannel, NotificationEvent } from "./port";
import { sendEmail } from "@/lib/email/send";
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

  async send(event: NotificationEvent): Promise<void> {
    for (const recipient of this.config.recipients) {
      try {
        const template = this.buildTemplate(event);
        if (template) {
          await sendEmail({ to: recipient, subject: event.title, template });
        }
      } catch (err) {
        console.error(
          `[notifications] Failed to send email to ${recipient}:`,
          err,
        );
      }
    }
  }

  private buildTemplate(event: NotificationEvent) {
    const m = event.metadata;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const dashboardUrl = m.appId
      ? `${appUrl}/projects/${m.appId}`
      : appUrl;

    switch (event.type) {
      case "deploy-success":
        return DeploySuccessEmail({
          projectName: m.projectName || "Unknown",
          deploymentId: m.deploymentId || "",
          domain: m.domain,
          duration: m.duration || "unknown",
          gitSha: m.gitSha,
          gitMessage: m.gitMessage,
          gitAuthor: m.gitAuthor,
          gitBranch: m.gitBranch,
          triggeredBy: m.triggeredBy,
          triggerReason: m.triggerReason,
          imageName: m.imageName,
          imageTag: m.imageTag,
          buildStages: m.buildStages
            ? JSON.parse(m.buildStages)
            : undefined,
          dashboardUrl,
        });

      case "deploy-failed":
        return DeployFailedEmail({
          projectName: m.projectName || "Unknown",
          deploymentId: m.deploymentId || "",
          errorMessage: m.errorMessage,
          errorSnapshot: m.errorSnapshot,
          failedAtStage: m.failedAtStage,
          gitSha: m.gitSha,
          gitMessage: m.gitMessage,
          gitAuthor: m.gitAuthor,
          gitBranch: m.gitBranch,
          triggeredBy: m.triggeredBy,
          triggerReason: m.triggerReason,
          dashboardUrl,
        });

      case "backup-success":
        return BackupSuccessEmail({
          appName: m.appName || m.projectName || "Unknown",
          volumeNames: m.volumeNames
            ? JSON.parse(m.volumeNames)
            : [],
          totalSize: m.totalSize || "unknown",
          duration: m.duration || "unknown",
          storageBucket: m.storageBucket,
          storageTarget: m.storageTarget,
          dashboardUrl,
        });

      case "backup-failed":
        return BackupFailedEmail({
          appName: m.appName || m.projectName || "Unknown",
          volumeName: m.volumeName,
          errorMessage: m.errorMessage || event.message,
          dashboardUrl,
        });

      case "cron-failed":
        return CronFailedEmail({
          jobName: m.jobName || "Unknown job",
          appName: m.appName || m.projectName || "Unknown",
          command: m.command || "",
          errorOutput: m.errorOutput,
          duration: m.duration,
          exitCode: m.exitCode ? parseInt(m.exitCode) : undefined,
          dashboardUrl,
        });

      case "disk-write-alert":
        return DiskWriteAlertEmail({
          appName: m.appName || m.projectName || "Unknown",
          containerName: m.containerName,
          writeAmount: m.writeAmount || "unknown",
          threshold: m.threshold || "unknown",
          period: m.period,
          dashboardUrl,
        });

      case "volume-drift":
        return VolumeDriftEmail({
          appName: m.appName || m.projectName || "Unknown",
          volumeName: m.volumeName || "unknown",
          modifiedCount: parseInt(m.modifiedCount || "0"),
          addedCount: parseInt(m.addedCount || "0"),
          missingCount: parseInt(m.missingCount || "0"),
          changedFiles: m.changedFiles
            ? JSON.parse(m.changedFiles)
            : undefined,
          dashboardUrl,
        });

      case "auto-rollback":
        return AutoRollbackEmail({
          appName: m.appName || m.projectName || "Unknown",
          reason:
            m.reason || "Container crashed within grace period",
          fromDeploymentId: m.fromDeploymentId || "",
          toDeploymentId: m.toDeploymentId || "",
          dashboardUrl,
        });

      case "system-alert-service":
      case "system-alert-disk":
      case "system-alert-restart":
      case "system-alert-cert":
      case "system-alert-update":
        return SystemAlertEmail({
          alertType: event.type,
          title: event.title,
          message: event.message,
          details: m as Record<string, string>,
          dashboardUrl: appUrl,
        });

      case "weekly-digest":
        return WeeklyDigestEmail({
          orgName: m.orgName || "Your Organization",
          weekLabel: m.weekLabel || "",
          deploys: {
            total: parseInt(m.deploysTotal || "0"),
            succeeded: parseInt(m.deploysSucceeded || "0"),
            failed: parseInt(m.deploysFailed || "0"),
          },
          backups: {
            total: parseInt(m.backupsTotal || "0"),
            succeeded: parseInt(m.backupsSucceeded || "0"),
            failed: parseInt(m.backupsFailed || "0"),
          },
          cron: {
            totalFailures: parseInt(m.cronFailures || "0"),
            affectedJobs: m.cronAffectedJobs ? JSON.parse(m.cronAffectedJobs) : [],
          },
          alerts: {
            diskWriteAlerts: parseInt(m.diskWriteAlerts || "0"),
            volumeDrifts: parseInt(m.volumeDrifts || "0"),
          },
          projects: m.projects ? JSON.parse(m.projects) : [],
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
