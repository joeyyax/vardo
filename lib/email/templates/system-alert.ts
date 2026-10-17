import type { BusEvent } from "@/lib/bus/events";
import { formatDuration, plural } from "../format";
import { describeResolver } from "@/lib/system-alerts/cert-expiry";
import { linkedList, nameLink, type MailInline, type NotificationMailBody, type StatTile } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";
import { commitCount, versionLink } from "./lifecycle";

/** What stops while a shared service is down, and what it does for Vardo. Keyed by lowercase name. */
const SERVICE_IMPACT: Record<string, { impact: string; role: string; appsServing: boolean; restart: boolean }> = {
  postgresql: { impact: "The console, deploys and backups are down", role: "PostgreSQL is Vardo's database.", appsServing: true, restart: true },
  postgres: { impact: "The console, deploys and backups are down", role: "postgres is Vardo's database.", appsServing: true, restart: true },
  redis: { impact: "Deploys, metrics and live logs are paused", role: "redis holds Vardo's queues and cache.", appsServing: true, restart: true },
  collector: { impact: "Container metrics are paused", role: "The collector reads container and GPU metrics.", appsServing: true, restart: true },
  loki: { impact: "Logs and log search are paused", role: "Loki stores app logs.", appsServing: true, restart: true },
  promtail: { impact: "New log lines aren't collected", role: "Promtail ships container logs to Loki.", appsServing: true, restart: true },
  traefik: { impact: "Your apps' domains may not respond", role: "Traefik routes traffic and TLS for every app.", appsServing: false, restart: true },
  docker: { impact: "Deploys, restarts and metrics are paused", role: "Docker runs every container.", appsServing: false, restart: false },
  wireguard: { impact: "Mesh instances can't reach each other", role: "WireGuard carries the mesh tunnels.", appsServing: true, restart: true },
  "mesh forward": { impact: "Mesh requests can't reach the live console", role: "It forwards tunnel traffic to the live console.", appsServing: true, restart: false },
};

export type SystemAlertEvent = Extract<
  BusEvent,
  {
    type:
      | "system.service-down"
      | "system.restart-loop"
      | "system.cert-expiring"
      | "system.update-available"
      | "system.integration-permissions"
      | "app.auto-restarted";
  }
>;

/** "Oct 15". */
function dayLabel(iso: string, timeZone = "UTC"): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
}

/** Domains a certificate email links before "and N more". */
const CERT_DOMAINS_SHOWN = 5;

const CHALLENGE_BLOCKER = {
  DNS: "usually the Cloudflare API token or the DNS record",
  TLS: "usually DNS pointing elsewhere or port 443 blocked",
} as const;

function certExpiringMail(event: Extract<SystemAlertEvent, { type: "system.cert-expiring" }>, ctx: MailContext): NotificationMailBody {
  const domains = event.domains?.length ? event.domains : [event.domain];
  const expired = event.daysLeft <= 0;
  const days = Math.abs(event.daysLeft);
  const { issuer, challenge } = describeResolver(event.resolver);
  const app = event.app;

  const blocker = challenge ? `, ${CHALLENGE_BLOCKER[challenge]}` : "";
  const why = !issuer
    ? expired
      ? "Browsers refuse the connection until it's replaced."
      : `Port 443 serves a certificate that expires ${dayLabel(event.expiresAt, ctx.timeZone)}.`
    : expired
      ? `Browsers refuse the connection until it renews. ${issuer} renewal is failing${blocker}.`
      : `${issuer} renews 30 days ahead, so something is blocking it${blocker}.`;
  const unrenewed = issuer ? " and hasn't renewed" : "";

  const lead: MailInline[] = [];
  if (domains.length > 1) {
    const shown = domains.slice(0, CERT_DOMAINS_SHOWN).map((d) => ({ text: d, href: `https://${d}` }));
    const more = domains.length - shown.length;
    const list = more ? [...shown.flatMap((d, i) => (i ? [", ", nameLink(d.text, d.href)] : [nameLink(d.text, d.href)])), ` and ${plural(more, "more domain")}`] : linkedList(shown);
    lead.push("It covers ", ...list, expired ? ". " : `${unrenewed}. `);
  } else if (!expired && issuer) {
    lead.push("It hasn't renewed. ");
  }
  lead.push(why);

  const tiles: StatTile[] = [
    expired
      ? { label: "Expired", value: String(days), unit: days === 1 ? " day ago" : " days ago", sub: dayLabel(event.expiresAt, ctx.timeZone), hot: true }
      : { label: "Expires", value: String(days), unit: days === 1 ? " day" : " days", sub: dayLabel(event.expiresAt, ctx.timeZone), hot: true },
    ...(app ? [{ label: "App", value: app.name, href: appPage(ctx, app.id), sub: app.project }] : []),
  ];

  return {
    tone: expired ? "fail" : "warn",
    status: expired ? "Certificate expired" : "Certificate expiring",
    heading: expired
      ? `${event.domain}'s certificate expired`
      : `${event.domain}'s certificate expires in ${plural(event.daysLeft, "day")}`,
    preheader: why,
    blocks: [{ kind: "text", text: lead }, { kind: "tiles", tiles }],
    action: app ? { label: "Check the domain", href: appPage(ctx, app.id, "networking") } : { label: "Open admin", href: consolePage(ctx, "/admin") },
    footer: footerFor(ctx),
  };
}

export function systemAlertMail(event: SystemAlertEvent, ctx: MailContext): NotificationMailBody {
  const footer = footerFor(ctx);
  const admin = { label: "Open admin", href: consolePage(ctx, "/admin") };

  switch (event.type) {
    case "system.service-down": {
      const known = SERVICE_IMPACT[event.service.toLowerCase()];
      const latency = Number(event.latencyMs);
      const check = latency > 0 ? ` Its last check took ${formatDuration(latency)}.` : "";
      const restart = known?.restart ?? false;
      return {
        tone: "fail",
        status: "Service down",
        heading: event.subject ?? `${event.service} isn't responding`,
        preheader: known ? `${known.impact}.` : event.message,
        blocks: [
          ...(known?.appsServing ? [{ kind: "reassure" as const, strong: "Your apps are still serving.", text: "Only Vardo itself is affected." }] : []),
          {
            kind: "callout",
            tone: "bad",
            title: known?.impact ?? event.message,
            body: known ? `${known.role}${check}` : check.trim() || undefined,
            action: restart
              ? { label: "Restart shared services", href: consolePage(ctx, "/admin/settings/maintenance") }
              : { label: "Open maintenance", href: consolePage(ctx, "/admin/settings/maintenance") },
          },
        ],
        links: [{ label: "Admin", href: admin.href }],
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
    case "system.cert-expiring":
      return certExpiringMail(event, ctx);
    case "system.update-available": {
      const behind = event.commitsBehind ?? commitCount(event);
      const version = event.target ?? event.remoteHead;
      const lead = behind
        ? [versionLink(version, event), ` is ${plural(behind, "commit")} newer than what ${ctx.instanceName} runs.`]
        : [versionLink(version, event), ` is out; ${ctx.instanceName} runs ${event.localHead}.`];
      return {
        tone: "info",
        status: "Update available",
        mark: "↑",
        heading: "A Vardo update is available",
        preheader: `${version} is ready for ${ctx.instanceName}.`,
        blocks: [
          { kind: "text", text: [...lead, " Your apps keep running during the update."] },
          ...(event.selfDeploy ? [] : [{ kind: "section" as const, title: "Run on the host" }, { kind: "log" as const, lines: ["sudo vardo update"], highlight: [] }]),
        ],
        action: event.selfDeploy
          ? { label: "Update now", href: consolePage(ctx, "/admin/settings/maintenance?update=now#updates") }
          : { label: "Open updates", href: consolePage(ctx, "/admin/settings/maintenance#updates") },
        links: event.changesUrl ? [{ label: "What changed", href: event.changesUrl }] : [],
        footer,
      };
    }
    case "system.integration-permissions":
      return {
        tone: "warn",
        status: "Needs approval",
        heading: event.title,
        paragraphs: [event.message],
        facts: [
          { label: event.scope === "app" ? "App" : "Account", value: event.account },
          { label: "Permissions", value: event.missing.join(", ") },
          ...(event.features.length ? [{ label: "Off until then", value: event.features.join(", ") }] : []),
        ],
        action: { label: event.fixLabel, href: event.fixUrl },
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
