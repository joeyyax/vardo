// Pure pieces of the Security page's range view: ban status, probe categories and the details-start note. Client-safe.

import { isPermanent } from "./permanent";
import { hitLabel, pathLabeler } from "./labels";
import type { BanDetail, ProbeCount } from "./summary";

export type BanStatusKind = "active" | "expired" | "lifted" | "permanent";
export type BanStatus = { kind: BanStatusKind; label: string };

/** A ban's state now. A lifted ban stays lifted, permanent or not. */
export function banStatus(
  ban: { expiresAt: Date | string; liftedAt: Date | string | null; liftedByName?: string | null },
  now: Date = new Date(),
): BanStatus {
  if (ban.liftedAt) return { kind: "lifted", label: ban.liftedByName ? `Lifted by ${ban.liftedByName}` : "Lifted" };
  if (isPermanent(ban.expiresAt)) return { kind: "permanent", label: "Permanent" };
  if (new Date(ban.expiresAt).getTime() <= now.getTime()) return { kind: "expired", label: "Expired" };
  return { kind: "active", label: "Active" };
}

export type PathAppCount = { path: string | null; appId: string | null; count: number };
export type AppCategories = { appId: string | null; total: number; categories: ProbeCount[] };

function sorted(counts: Map<string, number>): ProbeCount[] {
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Probe counts by rule label, overall and per app, from path counts. */
export function probeCategories(
  rows: readonly PathAppCount[],
  labelFor: (path: string, appId: string | null) => string = pathLabeler(),
): { categories: ProbeCount[]; byApp: AppCategories[] } {
  const all = new Map<string, number>();
  const perApp = new Map<string | null, Map<string, number>>();
  for (const r of rows) {
    if (!r.path || r.count <= 0) continue;
    const label = labelFor(r.path, r.appId);
    all.set(label, (all.get(label) ?? 0) + r.count);
    const app = perApp.get(r.appId) ?? new Map<string, number>();
    app.set(label, (app.get(label) ?? 0) + r.count);
    perApp.set(r.appId, app);
  }
  const byApp = [...perApp].map(([appId, counts]) => {
    const categories = sorted(counts);
    return { appId, total: categories.reduce((s, c) => s + c.count, 0), categories };
  });
  byApp.sort((a, b) => b.total - a.total);
  return { categories: sorted(all), byApp };
}

export type RuleHit = { label: string; hits: number; bans: number };

/** Where recorded events stand in for counters: from the range start to when counting began, or null. */
export function fallbackUntil(since: Date, countingSince: Date | null, now: Date): Date | null {
  const until = countingSince ?? now;
  return until.getTime() > since.getTime() ? until : null;
}

/**
 * Hits by rule label: counter totals by rule id, plus event counts for the stretch before counting.
 * `bans` is how many of the given bans tried that label.
 */
export function ruleHitRows(opts: {
  counts: Readonly<Record<string, number>>;
  events: readonly PathAppCount[];
  details: Iterable<BanDetail | null | undefined>;
  labelFor?: (path: string, appId: string | null) => string;
}): RuleHit[] {
  const labelFor = opts.labelFor ?? pathLabeler();
  const hits = new Map<string, number>();
  const add = (label: string, n: number) => hits.set(label, (hits.get(label) ?? 0) + n);
  for (const [id, n] of Object.entries(opts.counts)) if (n > 0) add(hitLabel(id), n);
  for (const e of opts.events) if (e.path && e.count > 0) add(labelFor(e.path, e.appId), e.count);
  const bans = new Map<string, number>();
  for (const d of opts.details) for (const label of new Set(d?.categories.map((c) => c.label))) bans.set(label, (bans.get(label) ?? 0) + 1);
  return [...hits]
    .map(([label, n]) => ({ label, hits: n, bans: bans.get(label) ?? 0 }))
    .sort((a, b) => b.hits - a.hits || a.label.localeCompare(b.label));
}

/** "approximate before Oct 10", only when events stood in for counters. */
export function approximateNote(until: Date | null, eventHits: number): string | null {
  return until && eventHits > 0 ? `approximate before ${shortDate(until)}` : null;
}

/** "env files 41 · Laravel Ignition exploit (RCE) 28". */
export function categoryLine(categories: readonly ProbeCount[], max = 6): string {
  return categories.slice(0, max).map((c) => `${c.label} ${c.count.toLocaleString("en-US")}`).join(" · ");
}

function shortDate(at: Date): string {
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * A note when the range counts probes from before probe events were recorded.
 * `days` are Redis day counts (YYYY-MM-DD); `earliestEvent` is the first recorded probe event.
 */
export function detailsStartNote(opts: {
  start: Date;
  earliestEvent: Date | null;
  days?: readonly { day: string; count: number }[];
  probes?: number;
  recorded?: number;
}): string | null {
  const { start, earliestEvent } = opts;
  if (earliestEvent && earliestEvent.getTime() <= start.getTime()) return null;
  let countedOnly: number;
  if (opts.days) {
    const from = start.toISOString().slice(0, 10);
    const until = earliestEvent ? earliestEvent.toISOString().slice(0, 10) : "9999-12-31";
    countedOnly = opts.days.filter((d) => d.day >= from && d.day < until).reduce((s, d) => s + d.count, 0);
  } else {
    countedOnly = (opts.probes ?? 0) > (opts.recorded ?? 0) ? 1 : 0;
  }
  if (countedOnly <= 0) return null;
  return earliestEvent
    ? `Details start ${shortDate(earliestEvent)}; earlier probes were only counted.`
    : "No probe details recorded yet; these probes were only counted.";
}
