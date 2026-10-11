// Which bans and probes are worth reporting, and the report each one becomes.

import { matchProbe, probeLabel, type ProbeRule } from "../rules";
import { probeSummary, type ProbeCount } from "../summary";
import { sanitizeReportPath } from "./sanitize";
import type { AbuseReport, ReportCategory } from "./types";

export const COMMENT_MAX = 1000;
const EXAMPLE_PATHS = 3;
const SLACK_MS = 60_000;
/** Ban reasons this instance saw for itself. Shared and blocklist bans are never reported. */
const LOCAL_REASONS = new Set(["threshold", "trap", "canary"]);

export type DraftEvent = { ip: string; kind: string; path: string | null; createdAt: Date; appId?: string | null };

export type DraftInput = {
  ip: string;
  ban: { reason: string; createdAt: Date } | null;
  events: readonly DraftEvent[];
  windowMs: number;
  now: Date;
  /** Hosts and names the comment must never carry. */
  terms: readonly string[];
};

/** Categories one rule's hits fall under. */
export function ruleCategories(rule: ProbeRule): ReportCategory[] {
  if (rule.report === "exploit") return rule.category === "router" ? ["iot", "hacking"] : ["web-attack", "hacking"];
  if (rule.report === "credentials") return ["web-attack", "bad-bot"];
  return [];
}

export const BAN_CATEGORIES: Record<string, ReportCategory[]> = {
  trap: ["bad-bot", "web-attack"],
  canary: ["hacking", "web-attack"],
};

function tally(values: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The events that belong to this report: the ban's window, or the last window when there's no local ban. */
export function reportEvents(input: Pick<DraftInput, "ip" | "ban" | "events" | "windowMs" | "now">): DraftEvent[] {
  const anchor = input.ban && LOCAL_REASONS.has(input.ban.reason) ? input.ban.createdAt.getTime() : input.now.getTime();
  const from = anchor - input.windowMs - SLACK_MS;
  const to = Math.max(anchor, input.now.getTime()) + SLACK_MS;
  return input.events.filter((e) => e.ip === input.ip && e.createdAt.getTime() >= from && e.createdAt.getTime() <= to);
}

/** The report for an address, or null when nothing it did is high-confidence abuse. */
export function draftReport(input: DraftInput): AbuseReport | null {
  const localBan = input.ban && LOCAL_REASONS.has(input.ban.reason) ? input.ban : null;
  const events = reportEvents(input);
  const probes = events.filter((e) => e.kind === "probe" && e.path).map((e) => ({ path: e.path!, rule: matchProbe(e.path!)?.rule }));
  const exploits = probes.filter((p) => p.rule?.report === "exploit");
  const credentials = probes.filter((p) => p.rule?.report === "credentials");

  const reportable = exploits.length > 0 || (!!localBan && (localBan.reason !== "threshold" || credentials.length > 0));
  if (!reportable) return null;

  const categories = new Set<ReportCategory>();
  for (const p of exploits) ruleCategories(p.rule!).forEach((c) => categories.add(c));
  if (localBan) {
    for (const p of credentials) ruleCategories(p.rule!).forEach((c) => categories.add(c));
    for (const c of BAN_CATEGORIES[localBan.reason] ?? []) categories.add(c);
  }

  const parts: string[] = [];
  if (probes.length > 0) {
    const counts: ProbeCount[] = tally(probes.map((p) => probeLabel(p.path))).map(([label, count]) => ({ label, count }));
    parts.push(probeSummary(counts));
  }
  if (localBan?.reason === "trap") {
    const trap = events.filter((e) => e.kind === "trap" && e.path).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    parts.push(trap?.path ? `Fetched trap path ${sanitizeReportPath(trap.path, input.terms)}` : "Fetched a trap path");
  }
  if (localBan?.reason === "canary") parts.push("Used a decoy credential");
  const evidence = [...exploits, ...(localBan ? credentials : [])].map((p) => sanitizeReportPath(p.path, input.terms));
  const examples = tally(evidence).slice(0, EXAMPLE_PATHS).map(([path]) => path);
  if (examples.length > 0) parts.push(`Paths: ${examples.join(", ")}`);

  const comment = parts.join(". ");
  return {
    ip: input.ip,
    categories: [...categories].sort(),
    comment: comment.length > COMMENT_MAX ? `${comment.slice(0, COMMENT_MAX - 1)}…` : comment,
  };
}
