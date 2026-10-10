// Maps a bus event to its notification email: subject, HTML and plain text.

import { createElement } from "react";
import { render } from "react-email";
import type { BusEvent } from "@/lib/bus/events";
import { NotificationMail, notificationMailText, type NotificationMailBody } from "./templates/components";
import { appPage, consolePage, footerFor, type MailContext } from "./templates/context";
import { notificationSubject } from "./subjects";
import { deploySuccessMail } from "./templates/deploy-success";
import { deployFailedMail } from "./templates/deploy-failed";
import { deployIncompleteMail } from "./templates/deploy-incomplete";
import { autoRollbackMail } from "./templates/auto-rollback";
import { backupSummaryMail } from "./templates/backup";
import { securityScanMail } from "./templates/security-scan";
import { cronFailedMail } from "./templates/cron-failed";
import { diskWriteAlertMail } from "./templates/disk-write-alert";
import { volumeDriftMail } from "./templates/volume-drift";
import { systemAlertMail } from "./templates/system-alert";
import { healthDigestMail } from "./templates/health-digest";
import { lifecycleMail } from "./templates/lifecycle";
import { alertFiredMail, alertResolvedMail } from "./templates/alerts";

export type { MailContext } from "./templates/context";

const WARN_PREFIXES = ["security.", "system."];

function genericMail(event: BusEvent, ctx: MailContext): NotificationMailBody {
  const warn = WARN_PREFIXES.some((p) => event.type.startsWith(p));
  const appId = "appId" in event && typeof event.appId === "string" && event.appId ? event.appId : null;
  return {
    tone: warn ? "warn" : "info",
    status: warn ? "Needs a look" : "Update",
    heading: event.title,
    paragraphs: [event.message],
    action: appId ? { label: "Open app", href: appPage(ctx, appId) } : { label: "Open Vardo", href: consolePage(ctx) },
    footer: footerFor(ctx),
  };
}

/** The email body for an event, or null for events that never email. */
export function notificationMailBody(event: BusEvent, ctx: MailContext): NotificationMailBody | null {
  switch (event.type) {
    case "deploy.status":
    case "backup.progress":
    case "app.oom-killed":
    case "backup.success":
    case "backup.failed":
    case "backup.run-started":
      return null;
    case "deploy.success":
      return deploySuccessMail(event, ctx);
    case "deploy.failed":
      return deployFailedMail(event, ctx);
    case "deploy.incomplete":
      return deployIncompleteMail(event, ctx);
    case "deploy.rollback":
      return autoRollbackMail(event, ctx);
    case "backup.summary":
      return backupSummaryMail(event, ctx);
    case "cron.failed":
      return cronFailedMail(event, ctx);
    case "disk.write-alert":
      return diskWriteAlertMail(event, ctx);
    case "volume.drift":
      return volumeDriftMail(event, ctx);
    case "security.scan-findings":
      return securityScanMail(event, ctx);
    case "system.service-down":
    case "system.restart-loop":
    case "system.cert-expiring":
    case "system.update-available":
    case "app.auto-restarted":
      return systemAlertMail(event, ctx);
    case "alert.fired":
      return alertFiredMail(event, ctx);
    case "alert.resolved":
      return alertResolvedMail(event, ctx);
    case "system.shutdown":
    case "system.started":
    case "system.recovered-unclean":
    case "system.update-started":
    case "system.updated":
    case "system.update-failed":
    case "system.update-skipped":
    case "system.containers-missing":
      return lifecycleMail(event, ctx);
    case "digest.health":
      return healthDigestMail(event, ctx);
    default:
      return genericMail(event, ctx);
  }
}

export type RenderedNotification = { subject: string; html: string; text: string };

export async function renderNotificationEmail(event: BusEvent, ctx: MailContext): Promise<RenderedNotification | null> {
  const body = notificationMailBody(event, ctx);
  if (!body) return null;
  return {
    subject: notificationSubject(event, ctx),
    html: await render(createElement(NotificationMail, body)),
    text: notificationMailText(body),
  };
}
