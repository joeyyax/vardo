// Display helpers for uptime. Pure, so client components can import them.

import type { Check, DayTick, MonitorState, VantageView } from "./types";

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

export function stateLabel(state: MonitorState, downSince: number | null, now = Date.now()): string {
  if (state === "down") return downSince ? `Down for ${formatDuration(now - downSince)}` : "Down";
  return state === "up" ? "Up" : "No data";
}

export type TickTone = "up" | "partial" | "down" | "none";

/** Green for a clean day, red below 95 percent, amber between, grey with no checks. */
export function tickTone(day: Pick<DayTick, "minutesUp" | "minutesDown" | "uptimePct">): TickTone {
  if (day.minutesUp + day.minutesDown === 0) return "none";
  if (day.minutesDown === 0) return "up";
  return (day.uptimePct ?? 0) < 95 ? "down" : "partial";
}

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function tickTitle(day: DayTick): string {
  const date = dayFormat.format(day.start);
  const tone = tickTone(day);
  if (tone === "none") return `${date}: no data`;
  return `${date}: ${formatPct(day.uptimePct)}`;
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
