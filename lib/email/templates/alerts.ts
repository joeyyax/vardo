import type { AlertFiredEvent, AlertItem, AlertResolvedEvent } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { formatDuration } from "../format";
import type { MailFact, MailLink, MailVisual, NotificationMailBody } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";
import { hourlyColumns, sparkColumns } from "./visuals";

/** Charts drawn for a multi-alert email, worst first. */
const CHARTED_ALERTS = 2;

const APP_TAB: Record<string, string> = {
  "app.oom": "resources",
  "app.memory-limit": "resources",
  "app.restart-loop": "stability",
  "app.unhealthy": "logs",
  "backup.failure": "backups",
};

export function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${day}, ${date.toISOString().slice(11, 16)} UTC`;
}

function itemLink(item: AlertItem, ctx: MailContext): MailLink {
  if (item.appId) {
    const tab = APP_TAB[item.type];
    return { label: `Open ${item.appName ?? "app"}`, href: appPage(ctx, item.appId, tab) };
  }
  return { label: "Open metrics", href: consolePage(ctx, "/metrics") };
}

function itemVisuals(item: AlertItem, ctx: MailContext): MailVisual[] {
  const visuals: (MailVisual | undefined)[] = [];
  if (item.gauge) visuals.push({ kind: "gauge", ...item.gauge });
  if (item.series) {
    visuals.push(sparkColumns(item.series.title, item.series.values, { axis: ["1 h ago", "now"], caption: item.series.caption, over: item.gauge?.warn }));
  }
  if (item.type === "host.disk") {
    const docker = ctx.series?.dockerDisk24h;
    visuals.push(
      hourlyColumns("Docker data, last 24 h", docker, {
        caption: docker ? `Images, volumes and build cache, now ${formatBytesIec(docker.at(-1) ?? 0)}` : undefined,
      }),
    );
  }
  return visuals.filter((v) => v !== undefined);
}

function itemFacts(item: AlertItem): MailFact[] {
  return [...(item.facts ?? []), ...(item.since ? [{ label: "Since", value: timeLabel(item.since) }] : [])];
}

export function alertFiredMail(event: AlertFiredEvent, ctx: MailContext): NotificationMailBody {
  const items = event.alerts;
  const critical = items.some((a) => a.severity === "critical");
  const tone = critical ? "fail" : "warn";
  const footer = footerFor(ctx);
  const [first] = items;

  if (items.length === 1) {
    return {
      tone,
      status: critical ? "Critical" : "Warning",
      heading: first.title,
      preheader: first.detail,
      paragraphs: [first.detail],
      visuals: itemVisuals(first, ctx),
      facts: itemFacts(first),
      action: itemLink(first, ctx),
      footer,
    };
  }

  const links = items.slice(1).map((item) => itemLink(item, ctx));
  return {
    tone,
    status: `${items.length} alerts`,
    heading: `${items.length} alerts on ${ctx.instanceName}`,
    preheader: items.map((a) => a.title).join(", "),
    paragraphs: ["These started together, so they may share a cause. The worst is first."],
    visuals: items.slice(0, CHARTED_ALERTS).flatMap((item) => itemVisuals(item, ctx)),
    sections: items.map((item) => ({
      title: `${item.severity === "critical" ? "✗" : "!"} ${item.title}`,
      facts: [{ label: "", value: item.detail }, ...itemFacts(item)],
    })),
    action: itemLink(first, ctx),
    links: links.filter((link, i) => links.findIndex((l) => l.href === link.href) === i && link.href !== itemLink(first, ctx).href),
    footer,
  };
}

function resolvedLine(item: AlertResolvedEvent["alerts"][number]): string {
  const lasted = Date.parse(item.resolvedAt) - Date.parse(item.since ?? item.firedAt);
  return Number.isFinite(lasted) && lasted > 0 ? `Cleared after ${formatDuration(lasted)}` : "Cleared";
}

export function alertResolvedMail(event: AlertResolvedEvent, ctx: MailContext): NotificationMailBody {
  const items = event.alerts;
  const [first] = items;
  const heading = items.length === 1 ? `Resolved: ${first.title}` : `${items.length} alerts resolved on ${ctx.instanceName}`;
  return {
    tone: "success",
    status: "Resolved",
    heading,
    preheader: items.map((a) => `${a.title}, ${resolvedLine(a).toLowerCase()}`).join("; "),
    paragraphs: ["Back under the alert line. Nothing to do unless it comes back."],
    sections: items.map((item) => ({
      title: item.title,
      facts: [
        { label: "Alerted", value: timeLabel(item.firedAt) },
        { label: "Resolved", value: `${timeLabel(item.resolvedAt)}. ${resolvedLine(item)}.` },
      ],
    })),
    action: itemLink(first, ctx),
    footer: footerFor(ctx),
  };
}
