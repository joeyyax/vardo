import type { BusEvent } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { formatDuration } from "../format";
import type { NotificationMailBody } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";
import { hourlyColumns } from "./visuals";

/** The system monitor's disk thresholds (lib/system-alerts/monitor.ts). */
const DISK_WARN = 85;
const DISK_CRITICAL = 95;

export type SystemAlertEvent = Extract<
  BusEvent,
  {
    type:
      | "system.service-down"
      | "system.disk-alert"
      | "system.restart-loop"
      | "system.cert-expiring"
      | "system.update-available"
      | "app.auto-restarted"
      | "app.oom-killed";
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
    case "system.disk-alert": {
      const free = Math.max(0, event.total - event.used);
      return {
        tone: event.severity === "critical" ? "fail" : "warn",
        status: event.severity === "critical" ? "Disk critical" : "Disk filling up",
        heading: `Disk ${Math.round(event.percent)}% full on ${ctx.instanceName}`,
        preheader: `${formatBytesIec(free)} free of ${formatBytesIec(event.total)}`,
        paragraphs: ["Deploys and backups fail once the disk is full. Prune old images and build cache or grow the disk."],
        visuals: [
          { kind: "gauge" as const, title: "Disk used", percent: event.percent, warn: DISK_WARN, critical: DISK_CRITICAL },
          hourlyColumns("Docker data, last 24 h", ctx.series?.dockerDisk24h, {
            caption: ctx.series?.dockerDisk24h ? `Images, volumes and build cache, now ${formatBytesIec(ctx.series.dockerDisk24h.at(-1) ?? 0)}` : undefined,
          }),
        ].filter((v) => v !== undefined),
        facts: [
          { label: "Used", value: `${formatBytesIec(event.used)} of ${formatBytesIec(event.total)}` },
          { label: "Free", value: formatBytesIec(free) },
          { label: "Threshold", value: `${event.threshold}%` },
        ],
        action: admin,
        footer,
      };
    }
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
        heading: `A Vardo update is available for ${ctx.instanceName}`,
        paragraphs: ["Update when it suits you. Deployed apps keep running during the update."],
        facts: [
          { label: "Running", value: event.localHead, mono: true },
          { label: "Latest", value: event.remoteHead, mono: true },
        ],
        command: { title: "Run on the host", text: "sudo vardo update" },
        action: admin,
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
    case "app.oom-killed":
      return {
        tone: "fail",
        status: "Out of memory",
        heading: `${event.appName} was killed for memory`,
        paragraphs: [
          event.kind === "oom-limit"
            ? "The container hit its own memory limit. Raise the limit or find the leak."
            : "The host ran out of memory and the kernel killed this container.",
        ],
        facts: [
          { label: "Container", value: event.containerName, mono: true },
          { label: "Exit code", value: String(event.exitCode) },
          { label: "At", value: event.at },
        ],
        action: { label: "Open resources", href: appPage(ctx, event.appId, "resources") },
        footer,
      };
  }
}
