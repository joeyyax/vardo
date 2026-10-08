import type { BusEvent } from "./events";

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
    case "deploy.rollback":
      return { label: "View deploys", url: `/apps/${event.appId}/deployments` };
    case "app.auto-restarted":
    case "app.oom-killed":
      return { label: "View app", url: `/apps/${event.appId}/stability` };
    case "disk.write-alert":
      return { label: "View app", url: `/apps/${event.appId}` };
    case "cron.failed":
      return { label: "View cron jobs", url: `/apps/${event.appId}/cron` };
    case "backup.success":
    case "backup.failed":
      return { label: "View backups", url: "/backups" };
    case "system.service-down":
      return canLinkToAdmin
        ? { label: "View services", url: "/admin/settings/core-services" }
        : undefined;
    case "system.disk-alert":
    case "system.restart-loop":
      return canLinkToAdmin ? { label: "View system", url: "/admin" } : undefined;
    case "system.cert-expiring":
      return canLinkToAdmin
        ? { label: "View domains", url: "/admin/settings/domain" }
        : undefined;
    default:
      return undefined;
  }
}
