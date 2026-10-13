import type { BusEvent, UpdateChanges } from "@/lib/bus/events";
import { formatDuration, plural, truncate } from "../format";
import { describeResolver } from "@/lib/system-alerts/cert-expiry";
import { linkedList, nameLink, type MailFact, type MailInline, type MailLink, type NotificationMailBody, type StatTile } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";

/** Release-note lines an update email quotes. */
const NOTE_LINES = 3;

/** Release notes as plain lines: headings, bullets and emphasis stripped. */
function noteLines(notes: string): string[] {
  return notes
    .split("\n")
    .map((l) => l.replace(/^\s*(?:#+|[-*+]|\d+\.)\s+/, "").replace(/[*_`]+/g, "").trim())
    .filter(Boolean)
    .slice(0, NOTE_LINES)
    .map((l) => truncate(l, 160));
}

/** Release notes and a link to the full change history. */
export function changeSections(changes: UpdateChanges): { sections: { title: string; facts: MailFact[] }[]; paragraphs: string[]; links: MailLink[] } {
  const notes = changes.releaseNotes ? noteLines(changes.releaseNotes) : [];
  return {
    sections: notes.length ? [{ title: "What changed", facts: notes.map((n) => ({ label: "", value: n })) }] : [],
    paragraphs: [],
    links: changes.changesUrl ? [{ label: "Full change history on GitHub", href: changes.changesUrl }] : [],
  };
}

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
  const why = expired
    ? `Browsers refuse the connection until it renews. ${issuer ? `${issuer} renewal is failing${blocker}.` : "Renewal is failing."}`
    : `${issuer ?? "Traefik"} renews 30 days ahead, so something is blocking it${blocker}.`;

  const lead: MailInline[] = [];
  if (domains.length > 1) {
    const shown = domains.slice(0, CERT_DOMAINS_SHOWN).map((d) => ({ text: d, href: `https://${d}` }));
    const more = domains.length - shown.length;
    const list = more ? [...shown.flatMap((d, i) => (i ? [", ", nameLink(d.text, d.href)] : [nameLink(d.text, d.href)])), ` and ${plural(more, "more domain")}`] : linkedList(shown);
    lead.push("It covers ", ...list, expired ? ". " : " and hasn't renewed. ");
  } else if (!expired) {
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
    case "system.cert-expiring":
      return certExpiringMail(event, ctx);
    case "system.update-available": {
      const changes = changeSections(event);
      return {
        tone: "info",
        status: "Update available",
        mark: "↑",
        heading: `A Vardo update is available for ${ctx.instanceName}`,
        preheader: "A Vardo update is ready for this instance.",
        paragraphs: ["Update when it suits you. Deployed apps keep running during the update."],
        details: [
          { label: "Running", value: event.localHead, mono: true },
          { label: "Available", value: event.target ? `${event.target} (${event.remoteHead})` : event.remoteHead, mono: true },
          ...(event.commitsBehind ? [{ label: "Behind", value: plural(event.commitsBehind, "commit") }] : []),
        ],
        sections: changes.sections,
        ...(event.selfDeploy
          ? { action: { label: "Update now", href: consolePage(ctx, "/admin/settings/maintenance?update=now#updates") } }
          : { command: { title: "Run on the host", text: "sudo vardo update" }, action: admin }),
        links: changes.links,
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
