import type { BusEvent } from "@/lib/bus/events";
import { formatDuration } from "../format";
import type { NotificationMailBody } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";

export type SystemAlertEvent = Extract<
  BusEvent,
  {
    type:
      | "system.service-down"
      | "system.restart-loop"
      | "system.cert-expiring"
      | "system.update-available"
      | "app.auto-restarted";
  }
>;

function dateLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function systemAlertMail(event: SystemAlertEvent, ctx: MailContext): NotificationMailBody {
  const footer = footerFor(ctx);
  const admin = { label: "Open admin", href: consolePage(ctx, "/admin") };

  switch (event.type) {
    case "system.service-down":
      return {
        tone: "fail",
        status: "Service down",
        heading: `${event.service} isn't responding`,
        paragraphs: [event.message],
        facts: [
          { label: "Service", value: event.service },
          ...(event.description ? [{ label: "Role", value: event.description }] : []),
          ...(event.latencyMs ? [{ label: "Last latency", value: `${event.latencyMs} ms` }] : []),
          { label: "Host", value: ctx.instanceName },
        ],
        action: admin,
        footer,
      };
    case "system.restart-loop":
      return {
        tone: "warn",
        status: "Restarted",
        heading: `Vardo restarted on ${ctx.instanceName}`,
        paragraphs: [event.message],
        facts: [{ label: "Uptime", value: formatDuration(event.uptimeSeconds * 1000) }],
        action: admin,
        footer,
      };
    case "system.cert-expiring": {
      const domains = event.domains?.length ? event.domains : [event.domain];
      const expired = event.daysLeft <= 0;
      return {
        tone: expired ? "fail" : "warn",
        status: expired ? "Certificate expired" : "Certificate expiring",
        heading: expired ? `The certificate for ${event.domain} expired` : `The certificate for ${event.domain} expires in ${event.daysLeft} days`,
        paragraphs: [event.message],
        facts: [
          { label: domains.length > 1 ? "Domains" : "Domain", value: domains.join(", ") },
          { label: "Expires", value: dateLabel(event.expiresAt) },
          { label: "Issuer", value: event.resolver },
        ],
        action: admin,
        footer,
      };
    }
    case "system.update-available":
      return {
        tone: "info",
        status: "Update available",
        mark: "↑",
        heading: `A Vardo update is available for ${ctx.instanceName}`,
        paragraphs: ["Update when it suits you. Deployed apps keep running during the update."],
        facts: [
          { label: "Running", value: event.localHead, mono: true },
          { label: "Latest", value: event.target ? `${event.target} (${event.remoteHead})` : event.remoteHead, mono: true },
          ...(event.commitsBehind ? [{ label: "Behind", value: `${event.commitsBehind} commit${event.commitsBehind === 1 ? "" : "s"}` }] : []),
        ],
        ...(event.selfDeploy
          ? { action: { label: "Update now", href: consolePage(ctx, "/admin/settings/maintenance?update=now#updates") } }
          : { command: { title: "Run on the host", text: "sudo vardo update" }, action: admin }),
        footer,
      };
    case "app.auto-restarted":
      return {
        tone: event.gaveUp || !event.success ? "fail" : "warn",
        status: event.gaveUp ? "Restarts stopped" : "Restarted",
        heading: event.gaveUp ? `${event.appName} keeps failing, so restarts stopped` : `${event.appName} was restarted`,
        paragraphs: [event.message],
        facts: [
          { label: "Reason", value: event.reason },
          { label: "Container", value: event.containerName, mono: true },
        ],
        action: { label: "Check app logs", href: appPage(ctx, event.appId, "logs") },
        footer,
      };
  }
}
