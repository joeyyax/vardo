import type { AlertFiredEvent, AlertItem, AlertResolvedEvent } from "@/lib/bus/events";
import { formatDurationRough } from "../format";
import { formatClock, formatDayTime, UTC, zoneAbbreviation } from "@/lib/time-zone";
import { nameLink, type ChartTone, type MailBlock, type MailFact, type MailInline, type MailLink, type MailRich, type MailVisual, type NotificationMailBody } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";
import { sparkColumns } from "./visuals";

/** Alerts this far apart in start time still read as starting together. */
const TOGETHER_MS = 15 * 60_000;

const APP_TAB: Record<string, string> = {
  "app.oom": "resources",
  "app.memory-limit": "resources",
  "app.restart-loop": "stability",
  "app.unhealthy": "logs",
  "app.anomaly": "resources",
  "app.new-port": "resources",
  "app.new-process": "resources",
  "backup.failure": "backups",
  "cron.failure": "cron",
};

export function timeLabel(iso: string, tz: string = UTC): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return formatDayTime(date, tz);
}

/** "14:05 PDT". */
function clockLabel(ms: number, tz: string = UTC): string {
  const date = new Date(ms);
  return `${formatClock(date, tz)} ${zoneAbbreviation(date, tz)}`;
}

function itemLink(item: AlertItem, ctx: MailContext): MailLink {
  if (item.view?.action) return { label: item.view.action.label, href: consolePage(ctx, item.view.action.path) };
  if (item.appId) {
    const tab = APP_TAB[item.type];
    const label = item.type === "app.oom" ? "Change the limit" : `Open ${item.appName ?? "app"}`;
    return { label, href: appPage(ctx, item.appId, tab) };
  }
  if (item.type === "cron.failure") return { label: "Open cron jobs", href: consolePage(ctx, "/cron") };
  return { label: "Open metrics", href: consolePage(ctx, "/metrics") };
}

/** Names the alert mentions that have a page: its app and any app in its table. */
function itemNames(item: AlertItem, ctx: MailContext): { text: string; href: string }[] {
  const names = item.appId && item.appName ? [{ text: item.appName, href: appPage(ctx, item.appId) }] : [];
  for (const row of item.view?.table?.rows ?? []) {
    if (row.appId) names.push({ text: row.name, href: appPage(ctx, row.appId) });
  }
  return names;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Links the first mention of each name, whole words only. */
export function linkNames(text: string, names: { text: string; href: string }[]): MailRich {
  const pending = names.filter((n) => n.text).sort((a, b) => b.text.length - a.text.length);
  const out: MailInline[] = [];
  let rest = text;
  while (rest) {
    let hit: { at: number; text: string; href: string } | null = null;
    for (const n of pending) {
      const m = new RegExp(`(?<![\\w])${escapeRegExp(n.text)}(?![\\w])`).exec(rest);
      if (m && (!hit || m.index < hit.at)) hit = { at: m.index, ...n };
    }
    if (!hit) {
      out.push(rest);
      break;
    }
    if (hit.at > 0) out.push(rest.slice(0, hit.at));
    out.push(nameLink(hit.text, hit.href));
    pending.splice(pending.findIndex((n) => n.text === hit.text), 1);
    rest = rest.slice(hit.at + hit.text.length);
  }
  return out.length === 1 && typeof out[0] === "string" ? out[0] : out;
}

function seriesColumns(title: string, values: number[], over: number | undefined): MailBlock[] {
  if (values.length < 2 || values.every((v) => v === 0)) return [];
  const columns = values.map((value) => ({ parts: [{ value, tone: (over !== undefined && value > over ? "fail" : 2) as ChartTone }] }));
  return [{ kind: "section", title }, { kind: "columns", columns, baseline: over === undefined ? "auto" : "zero", axis: ["1 h ago", "now"] }];
}

function dockerDisk(ctx: MailContext): MailBlock[] {
  const values = ctx.series?.dockerDisk24h;
  if (!values || values.length < 2) return [];
  return [
    { kind: "section", title: "Docker data, last 24 hours" },
    { kind: "columns", columns: values.map((value) => ({ parts: [{ value }] })), baseline: "auto", axis: ["24 h ago", "now"] },
  ];
}

/** The body of a one-alert email, from its view when it has one. */
function itemBlocks(item: AlertItem, ctx: MailContext): MailBlock[] {
  const view = item.view;
  const names = itemNames(item, ctx);
  const blocks: MailBlock[] = [];
  if (!view) {
    for (const p of [item.detail, item.next]) if (p) blocks.push({ kind: "text", text: linkNames(p, names) });
    if (item.gauge) blocks.push({ kind: "gauge", ...item.gauge });
    const spark: MailVisual | undefined = item.series
      ? sparkColumns(item.series.title, item.series.values, { axis: ["1 h ago", "now"], caption: item.series.caption, over: item.gauge?.warn })
      : undefined;
    if (spark) blocks.push(spark);
    if (item.type === "host.disk") blocks.push(...dockerDisk(ctx));
    const facts: MailFact[] = [...(item.facts ?? []), ...(item.since ? [{ label: "Since", value: timeLabel(item.since, ctx.timeZone) }] : [])];
    if (facts.length) blocks.push({ kind: "facts", facts });
    return blocks;
  }

  if (view.reassure) blocks.push({ kind: "reassure", strong: view.reassure.strong, text: view.reassure.text });
  for (const p of view.lead ?? [item.detail, ...(item.next ? [item.next] : [])]) blocks.push({ kind: "text", text: linkNames(p, names) });
  if (view.callout) {
    const { title, body } = view.callout;
    blocks.push({ kind: "callout", tone: item.severity === "critical" ? "bad" : "warn", title: linkNames(title, names), body: body && linkNames(body, names) });
  }
  if (item.gauge) {
    const { percent, warn, critical } = item.gauge;
    blocks.push({ kind: "gauge", percent, warn, critical, label: view.gaugeLabel });
  }
  if (item.series) blocks.push(...seriesColumns(item.series.title, item.series.values, view.seriesOver));
  if (item.type === "host.disk") blocks.push(...dockerDisk(ctx));
  if (view.tiles?.length) blocks.push({ kind: "tiles", tiles: view.tiles });
  if (view.table?.rows.length) {
    blocks.push({
      kind: "stats",
      columns: view.table.columns,
      rows: view.table.rows.map((row) => ({
        name: row.name,
        href: row.appId ? appPage(ctx, row.appId) : undefined,
        sub: row.sub,
        why: row.why,
        cells: row.cells.map((c) => ({ value: c.value, hot: c.hot })),
      })),
    });
    if (view.table.note) blocks.push({ kind: "note", text: view.table.note });
  }
  const since = view.sinceLabel && item.since ? [{ label: view.sinceLabel, value: timeLabel(item.since, ctx.timeZone) }] : [];
  const facts = [...(view.facts ?? []), ...since];
  if (facts.length) blocks.push({ kind: "facts", facts: facts.map((f) => ({ ...f, rich: linkNames(f.value, names) })) });
  return blocks;
}

function isHost(item: AlertItem): boolean {
  return item.type.startsWith("host.");
}

/** Metrics in the footer for a host alert whose button goes elsewhere. */
function metricsLink(items: AlertItem[], action: MailLink, ctx: MailContext): MailLink[] {
  const href = consolePage(ctx, "/metrics");
  return items.some(isHost) && action.href !== href ? [{ label: "Metrics", href }] : [];
}

/** "They started together at 14:02 PDT." and the likely shared cause, when the alerts support it. */
function togetherLead(items: AlertItem[], ctx: MailContext): string {
  const starts = items.map((a) => (a.since ? Date.parse(a.since) : NaN));
  const together = starts.every(Number.isFinite) && Math.max(...starts) - Math.min(...starts) <= TOGETHER_MS;
  const when = !together
    ? ""
    : items.some((a) => a.sinceAtLeast)
      ? `They've been going since at least ${clockLabel(Math.max(...starts), ctx.timeZone)}.`
      : `They started together at ${clockLabel(Math.min(...starts), ctx.timeZone)}.`;
  const memory = items.some((a) => a.type === "host.memory");
  const killed = items.filter((a) => a.hostMemory);
  if (!memory || killed.length === 0) return when || "They fired in the same check.";
  const others = items.length - 1;
  const which =
    killed.length === others
      ? others === 1
        ? "the other alert"
        : others === 2
          ? "the other two"
          : `the other ${others}`
      : killed.length === 1
        ? "one of the kills"
        : "the kills";
  return `${when} The host ran out of memory, which likely caused ${which}.`.trim();
}

export function alertFiredMail(event: AlertFiredEvent, ctx: MailContext): NotificationMailBody {
  const items = event.alerts;
  const critical = items.some((a) => a.severity === "critical");
  const tone = critical ? "fail" : "warn";
  const footer = footerFor(ctx);
  const [first] = items;

  if (items.length === 1) {
    const action = itemLink(first, ctx);
    return {
      tone,
      status: critical ? "Critical" : "Warning",
      heading: first.view?.heading ?? first.title,
      blocks: itemBlocks(first, ctx),
      action,
      links: metricsLink(items, action, ctx),
      footer,
    };
  }

  return {
    tone,
    status: `${items.length} alerts`,
    heading: `${items.length} alerts on ${ctx.instanceName}`,
    preheader: items.map((a) => a.view?.brief?.title ?? a.title).join(", "),
    blocks: [
      { kind: "text", text: togetherLead(items, ctx) },
      ...items.map((item): MailBlock => {
        const names = itemNames(item, ctx);
        const brief = item.view?.brief;
        return {
          kind: "callout",
          tone: item.severity === "critical" ? "bad" : "warn",
          title: linkNames(brief?.title ?? item.view?.heading ?? item.title, names),
          body: linkNames(brief?.body ?? [item.detail, item.next].filter(Boolean).join(" "), names),
          action: itemLink(item, ctx),
        };
      }),
    ],
    footer,
  };
}

type ResolvedItem = AlertResolvedEvent["alerts"][number];

function startedAt(item: ResolvedItem): number {
  return Date.parse(item.since ?? item.firedAt);
}

function lasted(item: ResolvedItem): string {
  const ms = Date.parse(item.resolvedAt) - startedAt(item);
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return item.sinceAtLeast ? `at least ${formatDurationRough(ms)}` : formatDurationRough(ms);
}

/** "Shop" over "near its memory limit" for an app alert; the title otherwise. */
function resolvedName(item: ResolvedItem): { name: string; sub?: string } {
  const title = item.view?.heading ?? item.title;
  if (!item.appName || !title.startsWith(`${item.appName} `)) return { name: title };
  return { name: item.appName, sub: title.slice(item.appName.length + 1).replace(/^is /, "") };
}

/** Threshold alerts clear by dropping under their line; the rest just clear. */
function resolvedLead(items: ResolvedItem[]): string {
  const lines = items.every((a) => a.gauge || a.series);
  if (items.length === 1) return lines ? "Back under its alert line." : "It cleared.";
  const who = items.length === 2 ? "Both" : `All ${items.length}`;
  return lines ? `${who} are back under their alert lines.` : `${who} cleared.`;
}

export function alertResolvedMail(event: AlertResolvedEvent, ctx: MailContext): NotificationMailBody {
  const items = event.alerts;
  const [first] = items;
  const heading = items.length === 1 ? `Resolved: ${first.view?.heading ?? first.title}` : `${items.length} alerts resolved`;
  return {
    tone: "success",
    status: "Resolved",
    heading,
    preheader: items.map((a) => `${a.title}, lasted ${lasted(a)}`).join("; "),
    blocks: [
      { kind: "text", text: resolvedLead(items) },
      {
        kind: "stats",
        columns: ["Alert", "Started", "Lasted"],
        rows: items.map((item) => ({
          ...resolvedName(item),
          href: item.appId ? appPage(ctx, item.appId) : undefined,
          cells: [Number.isFinite(startedAt(item)) ? `${item.sinceAtLeast ? "by " : ""}${clockLabel(startedAt(item), ctx.timeZone)}` : "—", lasted(item)],
        })),
      },
    ],
    links: items.some(isHost) ? [{ label: "Metrics", href: consolePage(ctx, "/metrics") }] : [],
    footer: footerFor(ctx),
  };
}
