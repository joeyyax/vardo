import type { BusEvent } from "./events";
import { appHref, deployHref } from "@/lib/ui/hrefs";

export type ToastAction = { label: string; url: string };

/** Where a toast's button goes. Instance-level links only appear for admins. */
export function toastActionFor(
  event: BusEvent,
  { canLinkToAdmin }: { canLinkToAdmin: boolean },
): ToastAction | undefined {
  switch (event.type) {
    case "deploy.success":
    case "deploy.failed":
    case "deploy.incomplete":
    case "deploy.rollback": {
      const app = ("appName" in event && event.appName) || event.appId;
      return event.deploymentId
        ? { label: "View deploy", url: deployHref(app, event.deploymentId) }
        : { label: "View deploys", url: appHref(app, "deployments") };
    }
    case "app.auto-restarted":
    case "app.oom-killed":
      return { label: "View app", url: `/apps/${event.appId}/stability` };
    case "disk.write-alert":
      return { label: "View app", url: `/apps/${event.appId}` };
    case "alert.fired": {
      const appId = event.alerts.find((a) => a.appId)?.appId;
      if (appId) return { label: "View app", url: `/apps/${appId}` };
      return canLinkToAdmin ? { label: "View metrics", url: "/metrics" } : undefined;
    }
    case "cron.failed":
      return { label: "View cron jobs", url: event.appId ? `/apps/${event.appId}/cron` : "/cron" };
    case "backup.success":
    case "backup.failed":
      return { label: "View backups", url: "/backups" };
    case "system.service-down":
      return canLinkToAdmin
        ? { label: "View services", url: "/admin/settings/core-services" }
        : undefined;
    case "system.restart-loop":
      return canLinkToAdmin ? { label: "View system", url: "/admin" } : undefined;
    case "system.cert-expiring":
      return canLinkToAdmin
        ? { label: "View domains", url: "/admin/settings/domain" }
        : undefined;
    case "system.integration-permissions":
      return { label: event.fixLabel, url: event.fixUrl };
    default:
      return undefined;
  }
}
