import type { AppRecap, DigestAppRecapEvent } from "@/lib/bus/events";
import { formatBytes } from "@/lib/metrics/format";
import { recapDueAt } from "@/lib/recaps/schedule";
import { UTC } from "@/lib/time-zone";
import { plural, possessive } from "../format";
import { nameLink, type MailBlock, type MailFact, type MailLink, type MailRich, type NotificationMailBody, type StatTile, type StatsRow } from "./components";
import { appPage, consolePage, footerFor, type MailContext } from "./context";

/** Memory this close to the limit gets a callout. */
export const NEAR_LIMIT = 0.9;

const DAY_MS = 86_400_000;

export const RECAP_LABEL: Record<AppRecap["kind"], string> = { "72h": "72-hour recap", "30d": "30-day recap" };

export type RecapIssue = {
  title: string;
  body: string;
  action: MailLink;
  /** Lowercase, after the subject's app name. */
  subject: string;
  /** One line under the app in the grouped table. */
  short: string;
  /** Link text for `short`. */
  shortAction: string;
};

function day(iso: string | Date, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

/** "2m 14s". */
export function buildTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const KB = 1024;
const MB = KB ** 2;
const GB = KB ** 3;

/** "640 MB", "0.9 GB", "14 GB": whole megabytes, gigabytes from 0.9 up. */
export function size(bytes: number): string {
  if (bytes < MB) return `${Math.max(0, Math.round(bytes / KB))} KB`;
  if (bytes < 0.9 * GB) return `${Math.round(bytes / MB)} MB`;
  const gb = bytes / GB;
  return `${gb < 10 ? Number(gb.toFixed(1)) : Math.round(gb)} GB`;
}

/** Always gigabytes, for a column that compares: "0.4 GB", "<0.1 GB". */
export function gigabytes(bytes: number): string {
  const gb = bytes / GB;
  if (gb < 0.1) return "<0.1 GB";
  return `${gb < 10 ? Number(gb.toFixed(1)) : Math.round(gb)} GB`;
}

/** "195 MB" as a tile value and unit. */
function bytesTile(bytes: number): { value: string; unit: string } {
  const [value, unit] = size(bytes).split(" ");
  return { value: value!, unit: ` ${unit}` };
}

/** "1.88 of 2 GB" when both share a unit, else "900 MB of 2 GB". */
function ofLimit(peak: number, limit: number): string {
  const [pv, pu] = formatBytes(peak, 2).split(" ");
  const [lv, lu] = formatBytes(limit, 2).split(" ");
  return pu === lu ? `${pv} of ${lv} ${lu}` : `${pv} ${pu} of ${lv} ${lu}`;
}

function pct(value: number): string {
  return `${Math.round(value)}%`;
}

/** "library" from "immich-library". */
function volumeShort(name: string, app: string): string {
  for (const sep of ["-", "_"]) if (name.startsWith(`${app}${sep}`) && name.length > app.length + 1) return name.slice(app.length + 1);
  return name;
}

export function nearLimit(memory: AppRecap["memory"]): boolean {
  return !!memory?.limit && memory.peak >= memory.limit * NEAR_LIMIT;
}

/** What needs a person, most pressing first. Resources only ever suggest more headroom. */
export function recapIssues(r: AppRecap, ctx: MailContext): RecapIssue[] {
  const tz = ctx.timeZone ?? UTC;
  const since = day(r.deployedAt, tz);
  const out: RecapIssue[] = [];

  const bare = r.volumes.filter((v) => v.unprotected);
  if (bare.length === 1) {
    const v = bare[0]!;
    out.push({
      title: `${v.name} isn't backed up`,
      body: v.sizeBytes ? `${size(v.sizeBytes)} with no backup yet.` : "No backup yet.",
      action: { label: "Set up backups", href: appPage(ctx, r.appId, "backups") },
      subject: `${volumeShort(v.name, r.appName)} isn't backed up`,
      short: `${v.name} isn't backed up`,
      shortAction: "Set up",
    });
  } else if (bare.length > 1) {
    out.push({
      title: `${bare.length} volumes aren't backed up`,
      body: `${bare.map((v) => v.name).join(", ")} have no backup yet.`,
      action: { label: "Set up backups", href: appPage(ctx, r.appId, "backups") },
      subject: `${bare.length} volumes aren't backed up`,
      short: `${bare.length} volumes aren't backed up`,
      shortAction: "Set up",
    });
  }

  const adjust = { label: "Adjust the limit", href: appPage(ctx, r.appId, "resources") };
  if (r.oomKills > 0) {
    const peak = r.memory?.limit ? ` It peaks at ${ofLimit(r.memory.peak, r.memory.limit)}.` : "";
    out.push({
      title: `Killed for memory ${times(r.oomKills)}`,
      body: `Since ${since}.${peak}`,
      action: adjust,
      subject: `killed for memory ${times(r.oomKills)}`,
      short: `Killed for memory ${times(r.oomKills)}`,
      shortAction: "Adjust limit",
    });
  } else if (nearLimit(r.memory)) {
    const m = r.memory!;
    const when = (m.daysNearLimit ?? 0) > 1 ? `on ${m.daysNearLimit} days` : `on ${day(m.peakAt, tz)}`;
    out.push({
      title: "Memory peaked near the limit",
      body: `${ofLimit(m.peak, m.limit!)} ${when}.`,
      action: adjust,
      subject: "memory near the limit",
      short: "Memory near the limit",
      shortAction: "Adjust limit",
    });
  }

  if (r.crashes > 0) {
    out.push({
      title: `Crashed ${times(r.crashes)}`,
      body: `Since ${since}. The logs show what it said before it stopped.`,
      action: { label: "Open logs", href: appPage(ctx, r.appId, "logs") },
      subject: `crashed ${times(r.crashes)}`,
      short: `Crashed ${times(r.crashes)}`,
      shortAction: "Logs",
    });
  }

  if (r.kind === "72h" && r.deploys.failed > 0) {
    out.push({
      title: `${plural(r.deploys.failed, "deploy")} failed`,
      body: `${r.deploys.failed} of ${r.deploys.total} since ${since}.`,
      action: { label: "Deployment log", href: appPage(ctx, r.appId, "deployments") },
      subject: `${plural(r.deploys.failed, "deploy")} failed`,
      short: `${plural(r.deploys.failed, "failed deploy")}`,
      shortAction: "View",
    });
  }

  if (r.scanFindings > 0) {
    out.push({
      title: `${plural(r.scanFindings, "open scan finding")}`,
      body: "From the latest security scan.",
      action: { label: "View findings", href: appPage(ctx, r.appId, "security") },
      subject: plural(r.scanFindings, "scan finding"),
      short: plural(r.scanFindings, "scan finding"),
      shortAction: "View",
    });
  }

  if (r.imageUpdates) {
    out.push({
      title: plural(r.imageUpdates, "image update"),
      body: "Newer versions of the images it runs are out.",
      action: { label: "View updates", href: appPage(ctx, r.appId) },
      subject: plural(r.imageUpdates, "image update"),
      short: plural(r.imageUpdates, "image update"),
      shortAction: "View",
    });
  }
  return out;
}

function tiles(r: AppRecap): StatTile[] {
  const deploys: StatTile = {
    label: "Deploys",
    value: String(r.deploys.total),
    sub: r.deploys.failed ? `${r.deploys.failed} failed` : r.deploys.total > 1 ? "all succeeded" : r.deploys.total === 1 ? "succeeded" : undefined,
  };
  const build: StatTile = r.build
    ? {
        label: "Average build",
        value: buildTime(r.build.avgMs),
        sub: r.kind === "30d" && r.build.earlyAvgMs ? `was ${buildTime(r.build.earlyAvgMs)}` : `fastest ${buildTime(r.build.fastestMs)}`,
      }
    : { label: "Average build", value: "—", sub: "prebuilt image" };

  const uptimeSub = (): string => {
    if (r.uptime && r.uptime.downMinutes > 0) return `${r.uptime.downMinutes} min down`;
    return r.crashes ? plural(r.crashes, "crash", "crashes") : "no restarts";
  };
  const uptime: StatTile = r.uptime
    ? { label: "Uptime", value: r.uptime.ratio >= 1 ? "100" : (Math.floor(r.uptime.ratio * 10_000) / 100).toFixed(2), unit: "%", sub: uptimeSub() }
    : { label: "Uptime", value: "—", sub: "no public domain" };

  const cpu: StatTile = r.cpu
    ? { label: "CPU", value: String(Math.round(r.cpu.avg)), unit: "%", sub: `peak ${pct(r.cpu.peak)}` }
    : { label: "CPU", value: "—", sub: "no samples" };

  const memory: StatTile = r.memory
    ? {
        label: "Memory",
        ...bytesTile(r.memory.avg),
        sub: r.memory.limit ? `peak ${ofLimit(r.memory.peak, r.memory.limit)}` : `peak ${size(r.memory.peak)}`,
        hot: nearLimit(r.memory) || r.oomKills > 0,
      }
    : { label: "Memory", value: "—", sub: "no samples" };

  let bandwidth: StatTile = { label: "Bandwidth", value: "—", sub: "no samples" };
  if (r.network) {
    const out = r.network.tx >= r.network.rx;
    const [big, small] = out ? [r.network.tx, r.network.rx] : [r.network.rx, r.network.tx];
    bandwidth = { label: "Bandwidth", ...bytesTile(big), sub: `${out ? "out" : "in"} · ${size(small)} ${out ? "in" : "out"}` };
  }
  return [deploys, build, uptime, cpu, memory, bandwidth];
}

function hasValues(values: number[] | undefined): values is number[] {
  return !!values?.length && values.some((v) => v > 0);
}

function facts(r: AppRecap, tz: string): MailFact[] {
  const out: MailFact[] = [];
  if (r.ports.length) out.push({ label: "Ports", value: r.ports.join(", "), rich: r.ports.map((p) => ({ chip: p })) });
  if (r.processes.length) out.push({ label: "Processes", value: r.processes.join(", ") });
  if (r.backups) out.push({ label: "Backups", value: [r.backups.schedule, r.backups.lastAt && `last ran ${day(r.backups.lastAt, tz)}`].filter(Boolean).join(", ") });
  return out;
}

function storage(r: AppRecap): MailBlock[] {
  const rows = r.volumes
    .filter((v) => v.sizeBytes !== null || v.unprotected)
    .map((v) => ({
      name: v.name,
      size: v.sizeBytes !== null ? size(v.sizeBytes) : "—",
      value: v.sizeBytes ?? 0,
      flag: v.unprotected ? "no backups" : undefined,
    }));
  if (!rows.length) return [];
  return [{ kind: "section", title: "Storage" }, { kind: "volumes", rows, caption: rows.length > 1 ? "Bars compare this app's volumes." : undefined }];
}

function timeline(r: AppRecap, tz: string): MailBlock {
  const deployed = new Date(r.deployedAt);
  return {
    kind: "timeline",
    current: r.kind === "72h" ? 1 : 2,
    steps: [
      { label: "Deployed", date: day(deployed, tz) },
      { label: "Baseline set", date: day(recapDueAt(deployed, "72h", tz), tz) },
      { label: "First month", date: day(recapDueAt(deployed, "30d", tz), tz) },
    ],
  };
}

/** "Next recap in 27 days." from a 72-hour recap. */
function nextRecapNote(r: AppRecap, tz: string): string | undefined {
  if (r.kind !== "72h") return undefined;
  const next = recapDueAt(new Date(r.deployedAt), "30d", tz).getTime();
  const days = Math.max(1, Math.round((next - new Date(r.until).getTime()) / DAY_MS));
  return `Next recap in ${plural(days, "day")}.`;
}

function singleMail(r: AppRecap, ctx: MailContext): NotificationMailBody {
  const tz = ctx.timeZone ?? UTC;
  const href = appPage(ctx, r.appId);
  const app = nameLink(r.appName, href);
  const lead: MailRich =
    r.kind === "72h"
      ? ["Vardo has a baseline for how ", app, " normally runs. If something changes outside a deploy, you'll get an email."]
      : [app, `${possessive(r.appName).slice(r.appName.length)} first month. This is the last recap. From here it's in your digest.`];
  const issues = recapIssues(r, ctx);

  const blocks: MailBlock[] = [{ kind: "text", text: lead }];
  for (const i of issues) blocks.push({ kind: "callout", tone: "warn", title: i.title, body: i.body, action: i.action });
  blocks.push(timeline(r, tz), { kind: "tiles", tiles: tiles(r) });

  if (r.kind === "30d" && r.deploysByDay?.some((d) => d.succeeded + d.failed > 0)) {
    blocks.push(
      { kind: "section", title: "Deploys per day" },
      {
        kind: "columns",
        columns: r.deploysByDay.map((d) => ({ parts: [{ value: d.succeeded + d.failed, tone: d.failed ? "fail" : 1 }] })),
        legend: [
          { label: "succeeded", tone: 1 },
          { label: "had a failure", tone: "fail" },
        ],
      },
    );
  }
  if (r.kind === "72h" && hasValues(r.hours)) blocks.push({ kind: "section", title: "Busiest hours" }, { kind: "hours", values: r.hours });
  blocks.push(...storage(r));
  if (r.kind === "30d" && r.backups?.nights?.some((n) => n !== "none")) {
    const ran = r.backups.nights.filter((n) => n === "ok").length;
    blocks.push(
      { kind: "section", title: "Nightly backups" },
      { kind: "days", days: r.backups.nights, legend: ["ran", "failed"], summary: `${ran} of ${r.backups.nights.length} ran` },
    );
  }
  if (r.kind === "72h") {
    const f = facts(r, tz);
    if (f.length) blocks.push({ kind: "facts", facts: f });
  }

  const label = RECAP_LABEL[r.kind];
  return {
    tone: issues.length ? "warn" : "info",
    status: "Recap",
    heading: `${label}: ${r.appName}`,
    preheader: issues.length ? issues.map((i) => i.title).join(" · ") : r.kind === "72h" ? `Vardo has a baseline for how ${r.appName} normally runs.` : `${possessive(r.appName)} first month.`,
    blocks,
    action: { label: `Open ${r.appName}`, href },
    footer: { ...footerFor(ctx), note: nextRecapNote(r, tz) },
  };
}

/** The grouped email's heading: one kind, or both. */
function groupLabel(recaps: AppRecap[]): string {
  const kinds = new Set(recaps.map((r) => r.kind));
  return kinds.size === 1 ? RECAP_LABEL[recaps[0]!.kind] : "App recaps";
}

function groupRow(r: AppRecap, ctx: MailContext, mixed: boolean): StatsRow {
  const issue = recapIssues(r, ctx)[0];
  const storageBytes = r.volumes.reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0);
  const anySize = r.volumes.some((v) => v.sizeBytes !== null);
  const hot = nearLimit(r.memory) || r.oomKills > 0;
  return {
    name: r.appName,
    href: appPage(ctx, r.appId),
    sub: mixed ? (r.kind === "72h" ? "72 hours" : "30 days") : undefined,
    why: issue ? [`${issue.short} · `, nameLink(issue.shortAction, issue.action.href)] : undefined,
    cells: [
      r.cpu ? pct(r.cpu.avg) : "—",
      r.memory ? { value: size(r.memory.avg), hot, sub: hot ? "at limit" : undefined } : "—",
      anySize ? gigabytes(storageBytes) : "—",
      r.network ? gigabytes(r.network.rx + r.network.tx) : "—",
    ],
  };
}

function groupedMail(event: DigestAppRecapEvent, ctx: MailContext): NotificationMailBody {
  const tz = ctx.timeZone ?? UTC;
  const { recaps } = event;
  const n = recaps.length;
  const kinds = new Set(recaps.map((r) => r.kind));
  const mixed = kinds.size > 1;
  const needs = recaps.filter((r) => recapIssues(r, ctx).length > 0);
  const ordered = [...needs, ...recaps.filter((r) => !needs.includes(r))];
  const lead = mixed
    ? `Recaps for ${n} new apps. If one changes outside a deploy, you'll get an email.`
    : kinds.has("72h")
      ? `Vardo has a baseline for all ${n}. If one changes outside a deploy, you'll get an email.`
      : `The first month for all ${n}. This is their last recap. From here they're in your digest.`;
  const note = !mixed && kinds.has("72h") ? nextRecapNote(recaps[0]!, tz) : undefined;

  return {
    tone: needs.length ? "warn" : "info",
    status: "Recap",
    heading: `${groupLabel(recaps)}: ${n} apps`,
    preheader: needs.length ? `${needs.length} need you · ${needs.map((r) => r.appName).join(", ")}` : lead,
    blocks: [
      { kind: "text", text: lead },
      {
        kind: "stats",
        columns: ["App", "CPU", "Memory", "Storage", "Bandwidth"],
        rows: ordered.map((r) => groupRow(r, ctx, mixed)),
        footer: "CPU and memory are averages. Bandwidth is in plus out.",
      },
    ],
    action: { label: "Open Vardo", href: consolePage(ctx, "/projects") },
    footer: { ...footerFor(ctx), note },
  };
}

export function appRecapMail(event: DigestAppRecapEvent, ctx: MailContext): NotificationMailBody | null {
  if (event.recaps.length === 0) return null;
  return event.recaps.length === 1 ? singleMail(event.recaps[0]!, ctx) : groupedMail(event, ctx);
}

/** "72-hour recap: immich · library isn't backed up", "72-hour recap: 12 apps · 3 need you". */
export function appRecapSubject(event: DigestAppRecapEvent): string {
  const { recaps } = event;
  if (recaps.length === 1) {
    const r = recaps[0]!;
    const first = recapIssues(r, { baseUrl: "", instanceName: "" })[0];
    return `${RECAP_LABEL[r.kind]}: ${r.appName}${first ? ` · ${first.subject}` : ""}`;
  }
  const needs = recaps.filter((r) => recapIssues(r, { baseUrl: "", instanceName: "" }).length > 0).length;
  return `${groupLabel(recaps)}: ${recaps.length} apps${needs ? ` · ${needs} need you` : ""}`;
}
