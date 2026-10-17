// Display helpers for uptime. Pure, so client components can import them.

import { coverage, sinceLabel } from "./core/range";
import type { Check, CheckPath, DayTick, DisplayState, ErrorKind, MonitorState, Reading, VantageView } from "./types";

/** Why a check failed, in words. */
export const ERROR_TEXT: Record<ErrorKind, string> = {
  timeout: "timed out",
  dns: "DNS lookup failed",
  refused: "connection refused",
  reset: "connection reset",
  tls: "TLS error",
  "cert-expired": "certificate expired",
  "cert-expiring": "certificate expiring",
  status: "unexpected status",
  keyword: "keyword missing",
  "no-route": "no route: Vardo has nothing serving this host",
  invalid: "invalid target",
  "private-address": "private address, not checked",
  blocked: "address not allowed",
  unknown: "check failed",
};

const CACHE_NAMES: Record<string, string> = {
  cloudflare: "Cloudflare's cache",
  vercel: "Vercel's cache",
  cloudfront: "CloudFront's cache",
  fastly: "Fastly's cache",
  proxy: "a proxy cache",
};

/** "Answered from Cloudflare's cache, …" for a check a cache answered. */
export function cacheNote(cache: string): string {
  return `Answered from ${CACHE_NAMES[cache] ?? "a cache"}, so it can't tell whether the app is up.`;
}

/** A body size such as "412 KB", or "over 64 KB" when reading stopped at the cap. */
export function formatBytes(bytes: number, atLeast = false): string {
  const kb = Math.round(bytes / 1024);
  return `${atLeast ? "over " : ""}${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`}`;
}

export function intervalLabel(sec: number): string {
  return sec === 30 ? "30 seconds" : sec === 300 ? "5 minutes" : "1 minute";
}

export function intervalPhrase(sec: number): string {
  return sec === 30 ? "every 30 seconds" : sec === 300 ? "every 5 minutes" : "every minute";
}

export function checkLabel(check: Check): string {
  return check.type === "http" ? "HTTP" : check.type === "tcp" ? "TCP port" : "TLS certificate";
}

/** What counts as passing, such as `200–399` or `contains "ok"`. */
export function expectation(check: Check): string {
  if (check.type === "http") {
    const { min, max } = check.expectedStatus;
    const range = min === max ? `${min}` : `${min}–${max}`;
    return check.keyword ? `${range}, contains "${check.keyword}"` : range;
  }
  return check.type === "tls" ? `expires in more than ${check.warnDays} days` : "accepts connections";
}

export function formatPct(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct.toFixed(2)}%`;
}

export function formatMs(ms: number | null): string {
  return ms === null ? "—" : `${ms} ms`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

export function stateLabel(state: DisplayState, downSince: number | null, now = Date.now()): string {
  if (state === "down") return downSince ? `Down for ${formatDuration(now - downSince)}` : "Down";
  return state === "up" ? "Up" : state === "degraded" ? "Degraded" : state === "review" ? "Needs review" : state === "stopped" ? "Stopped" : "No data";
}

/** The disagreement in a few words, such as "Unreachable from outside". */
export function readingLabel(reading: Reading): string {
  switch (reading.kind) {
    case "unreachable-outside":
      return "Unreachable from outside";
    case "unreachable-mesh":
      return "Unreachable over the mesh";
    case "local-only":
      return "Failing from this instance only";
    case "vantage-failing":
      return `Failing from ${joinNames(reading.vantages)}`;
  }
}

/** What the disagreement points at. */
export function readingDetail(reading: Reading): string {
  switch (reading.kind) {
    case "unreachable-outside":
      return "Checks from outside fail while this instance reaches it. Look at DNS, the certificate, the CDN or a firewall; the app itself is up.";
    case "unreachable-mesh":
      return "The app answers on this instance but not over the mesh. Look at the link or the linked instance.";
    case "local-only":
      return "Other vantage points reach it. Look at this instance's network or DNS.";
    case "vantage-failing":
      return "The other vantage points reach it.";
  }
}

/** The incident title for a monitor in a state. */
export function incidentTitle(name: string, state: MonitorState, reading?: Reading): string {
  if (!reading) return `${name} is down`;
  switch (reading.kind) {
    case "unreachable-outside":
      return `${name} is unreachable from outside`;
    case "unreachable-mesh":
      return `${name} is unreachable over the mesh`;
    case "local-only":
      return `${name} is failing from this instance only`;
    case "vantage-failing":
      return `${name} is ${state === "down" ? "down" : "failing"} from ${joinNames(reading.vantages)}`;
  }
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "a vantage point";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** How a vantage point's results got to the target, such as "External · public". */
export function pathLabel(kind: VantageView["kind"], path: CheckPath): string {
  if (kind === "local") return "Local";
  return path === "mesh" ? "External · mesh" : "External · public";
}

/** "Reported by Long House · watched by jy0". */
export function reportNote(report: { by: string; to: string[] } | null): string | null {
  return report && report.to.length > 0 ? `Reported by ${report.by} · watched by ${joinNames(report.to)}` : null;
}

export type TickTone = "up" | "partial" | "down" | "none";

/** Green for a clean day, red below 95 percent, amber between, grey with no checks. */
export function tickTone(day: Pick<DayTick, "minutesUp" | "minutesDown" | "uptimePct">): TickTone {
  if (day.minutesUp + day.minutesDown === 0) return "none";
  if (day.minutesDown === 0) return "up";
  return (day.uptimePct ?? 0) < 95 ? "down" : "partial";
}

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const timeFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

/** A bar's hover text: the day for daily bars, the time (UTC) for narrower ones. */
export function tickTitle(day: DayTick, barMs = 86_400_000): string {
  const date = barMs < 86_400_000 ? `${timeFormat.format(day.start)} UTC` : dayFormat.format(day.start);
  const tone = tickTone(day);
  if (tone === "none") return `${date}: no data`;
  return `${date}: ${formatPct(day.uptimePct)}`;
}

/** "30 days", or "Since Oct 16" when the monitor is younger than that. */
export function figureLabel(spanMs: number, spanLabel: string, createdAt: number | null, now = Date.now()): string {
  const { label, since } = coverage(spanMs, createdAt, now, spanLabel);
  return since ? `S${label.slice(1)}` : label;
}

/**
 * The 24 hour, 30 day and 90 day figures as tiles. Tiles the history doesn't fill collapse into one "Since …" tile,
 * so a young monitor doesn't show the same number three times.
 */
export function figureTiles(createdAt: number | null, now: number, v: { h24: number | null; d30: number | null; d90: number | null }): { label: string; value: string }[] {
  const spans = [
    { ms: 86_400_000, label: "24 hours", pct: v.h24 },
    { ms: 30 * 86_400_000, label: "30 days", pct: v.d30 },
    { ms: 90 * 86_400_000, label: "90 days", pct: v.d90 },
  ];
  const full = spans.filter((s) => !coverage(s.ms, createdAt, now, s.label).since);
  const short = spans.find((s) => coverage(s.ms, createdAt, now, s.label).since);
  const tiles = full.map((s) => ({ label: s.label, value: formatPct(s.pct) }));
  if (short) tiles.push({ label: figureLabel(short.ms, short.label, createdAt, now), value: formatPct(short.pct) });
  return tiles;
}

/** "99.98%", with "since Oct 16" after it when the history is shorter than the range. */
export function figureWithSince(pct: number | null, since: number | null, now = Date.now()): string {
  return since === null ? formatPct(pct) : `${formatPct(pct)} since ${sinceLabel(since, now)}`;
}

/** "this instance", "Frankfurt", "this instance and Frankfurt". */
export function vantageNames(vantages: Pick<VantageView, "name" | "kind">[]): string {
  const names = vantages.map((v) => (v.kind === "local" ? "this instance" : v.name));
  if (names.length <= 1) return names[0] ?? "this instance";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The mean of the monitors' 30-day uptimes that have data. */
export function averageUptime(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return null;
  return Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 100) / 100;
}
