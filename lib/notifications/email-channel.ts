import { createElement } from "react";
import type { NotificationChannel, NotificationEvent } from "./port";
import { sendEmail } from "@/lib/email/send";
import { DeploySuccessEmail } from "@/lib/email/templates/deploy-success";
import { DeployFailedEmail } from "@/lib/email/templates/deploy-failed";

type EmailConfig = { recipients: string[] };

export class EmailNotificationChannel implements NotificationChannel {
  constructor(private config: EmailConfig) {}
  async send(event: NotificationEvent): Promise<void> {
    for (const recipient of this.config.recipients) {
      try {
        const template = this.buildTemplate(event);
        if (template) await sendEmail({ to: recipient, subject: event.title, template });
      } catch (err) { console.error(`[notifications] Failed to send email to ${recipient}:`, err); }
    }
  }
  private buildTemplate(event: NotificationEvent) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const dashboardUrl = event.metadata.appId ? `${appUrl}/projects/${event.metadata.appId}` : appUrl;
    switch (event.type) {
      case "deploy-success": return DeploySuccessEmail({ projectName: event.metadata.projectName || "Unknown", deploymentId: event.metadata.deploymentId || "", domain: event.metadata.domain, duration: event.metadata.duration || "unknown", gitSha: event.metadata.gitSha, gitMessage: event.metadata.gitMessage, triggeredBy: event.metadata.triggeredBy, dashboardUrl });
      case "deploy-failed": return DeployFailedEmail({ projectName: event.metadata.projectName || "Unknown", deploymentId: event.metadata.deploymentId || "", errorMessage: event.metadata.errorMessage, gitSha: event.metadata.gitSha, gitMessage: event.metadata.gitMessage, triggeredBy: event.metadata.triggeredBy, dashboardUrl });
      default: return createElement("div", { style: { fontFamily: "sans-serif", padding: "20px", maxWidth: "600px" } },
        createElement("h2", { style: { margin: "0 0 12px" } }, event.title),
        createElement("p", { style: { color: "#374151", whiteSpace: "pre-wrap" } }, event.message),
        createElement("hr", { style: { border: "none", borderTop: "1px solid #e5e7eb", margin: "20px 0" } }),
        createElement("a", { href: dashboardUrl, style: { color: "#6366f1" } }, "View Dashboard")
      );
    }
  }
}
