// The Security page's range view: counts, recent bans, what was probed and top sources, for one app or all.

import { and, count, desc, eq, gt, gte, inArray, lt, isNull, min, ne, notInArray, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { probeBans, probeEvents, user } from "@/lib/db/schema";
import { bansSince, permanentBanCount } from "./bans";
import { banDetails } from "./ban-detail";
import { trapsSince } from "./events";
import { exemptProbeEvents } from "./exempt-events";
import { dailyHits, hourlyHits, ruleHits, type DayCount, type RuleHitCounts } from "./hits";
import { getProbeGuardSettings } from "./instance";
import { banReports } from "./overview";
import { pathLabeler } from "./labels";
import { guardBlocks } from "./sync";
import { rangeBuckets, rangeLabel, rangePhrase, rangeStart, type GuardRange } from "./range";
import { approximateNote, banStatus, detailsStartNote, fallbackUntil, probeCategories, ruleHitRows, type AppCategories, type BanStatus, type RuleHit } from "./history-view";
import type { BanDetail, ProbeCount } from "./summary";
import type { GuardStats } from "./overview";

export const HISTORY_BANS = 200;
export const TOP_SOURCES = 5;
/** Redis keeps day counts a little past retention. */
const COUNTED_DAYS = 92;

export type HistoryBan = {
  id: string;
  ip: string;
  reason: string;
  hits: number;
  originName: string | null;
  appId: string | null;
  createdAt: Date;
  expiresAt: Date;
  liftedAt: Date | null;
  liftedByName: string | null;
  blockedCount: number;
  lastBlockedAt: Date | null;
  status: BanStatus;
  detail: BanDetail | null;
  reportedTo: string | null;
};

export type TopSource = { ip: string; count: number; banned: boolean };

export type GuardHistory = {
  range: GuardRange;
  label: string;
  phrase: string;
  since: Date;
  stats: GuardStats;
  bans: HistoryBan[];
  categories: ProbeCount[];
  rules: RuleHit[];
  /** Set when events stood in for counters. */
  probedNote: string | null;
  byApp: AppCategories[];
  sources: TopSource[];
  note: string | null;
};

function scoped(table: typeof probeEvents | typeof probeBans, appId: string | undefined, filters: SQL[]): SQL | undefined {
  if (appId) filters.push(eq(table.appId, appId));
  return and(...filters);
}

/** The first retained probe event, ban and counted day, for "All time" and the details note. */
async function earliest(appId: string | undefined, days: DayCount[]) {
  const [[event], [ban]] = await Promise.all([
    db.select({ at: min(probeEvents.createdAt) }).from(probeEvents).where(scoped(probeEvents, appId, [eq(probeEvents.kind, "probe")])),
    db.select({ at: min(probeBans.createdAt) }).from(probeBans).where(scoped(probeBans, appId, [ne(probeBans.reason, "blocklist")])),
  ]);
  const counted = [...days].reverse().find((d) => d.count > 0);
  const candidates = [event?.at, ban?.at, counted ? new Date(`${counted.day}T00:00:00.000Z`) : null].filter((d): d is Date => !!d);
  return {
    event: event?.at ?? null,
    any: candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null,
  };
}

export async function guardHistory(opts: { range: GuardRange; appId?: string; now?: Date }): Promise<GuardHistory> {
  const { range, appId } = opts;
  const now = opts.now ?? new Date();
  const days = await dailyHits(appId ?? null, COUNTED_DAYS, now).catch(() => [] as DayCount[]);
  const first = await earliest(appId, days);
  const since = rangeStart(range, now, first.any);
  const buckets = rangeBuckets(range, now, first.any);

  const probes =
    buckets.unit === "hour"
      ? await hourlyHits(appId ?? null, buckets.count, now).catch(() => 0)
      : days.slice(0, range === "all" ? COUNTED_DAYS : buckets.count).reduce((s, d) => s + d.count, 0);

  const counted: RuleHitCounts = await ruleHits(appId ?? null, buckets.unit, buckets.count, now).catch(() => ({ counts: {}, since: null }));
  const until = fallbackUntil(since, counted.since, now);

  // Hits recorded before bans' exempt addresses stopped being counted stay in the table and out of the summary.
  const exempt = await exemptProbeEvents(since, appId).catch(() => ({ ips: [] as string[], count: 0 }));
  const probeFilters = (extra: SQL[] = []) => {
    const filters = [eq(probeEvents.kind, "probe"), gte(probeEvents.createdAt, since), ...extra];
    if (exempt.ips.length > 0) filters.push(notInArray(probeEvents.ip, exempt.ips));
    return scoped(probeEvents, appId, filters);
  };

  const [bans, traps, permanent, banRows, pathRows, earlierRows, sourceRows, settings] = await Promise.all([
    bansSince(since, appId),
    trapsSince(since, appId),
    permanentBanCount(appId),
    db
      .select({
        id: probeBans.id,
        ip: probeBans.ip,
        reason: probeBans.reason,
        hits: probeBans.hits,
        originName: probeBans.originName,
        appId: probeBans.appId,
        createdAt: probeBans.createdAt,
        expiresAt: probeBans.expiresAt,
        liftedAt: probeBans.liftedAt,
        liftedByName: user.name,
        blockedCount: probeBans.blockedCount,
        lastBlockedAt: probeBans.lastBlockedAt,
      })
      .from(probeBans)
      .leftJoin(user, eq(user.id, probeBans.liftedBy))
      .where(scoped(probeBans, appId, [gte(probeBans.createdAt, since), ne(probeBans.reason, "blocklist")]))
      .orderBy(desc(probeBans.createdAt))
      .limit(HISTORY_BANS),
    db
      .select({ path: probeEvents.path, appId: probeEvents.appId, count: count() })
      .from(probeEvents)
      .where(probeFilters())
      .groupBy(probeEvents.path, probeEvents.appId),
    until
      ? db
          .select({ path: probeEvents.path, appId: probeEvents.appId, count: count() })
          .from(probeEvents)
          .where(probeFilters([lt(probeEvents.createdAt, until)]))
          .groupBy(probeEvents.path, probeEvents.appId)
      : Promise.resolve([] as { path: string | null; appId: string | null; count: number }[]),
    db
      .select({ ip: probeEvents.ip, count: count() })
      .from(probeEvents)
      .where(probeFilters())
      .groupBy(probeEvents.ip)
      .orderBy(desc(count()))
      .limit(TOP_SOURCES),
    getProbeGuardSettings(),
  ]);

  const sourceIps = sourceRows.map((s) => s.ip);
  const [details, reports, activeIps] = await Promise.all([
    banDetails(banRows, settings.windowMinutes * 60_000).catch(() => new Map<string, BanDetail>()),
    banReports(banRows).catch(() => new Map<string, string>()),
    sourceIps.length
      ? db
          .select({ ip: probeBans.ip })
          .from(probeBans)
          .where(and(inArray(probeBans.ip, sourceIps), isNull(probeBans.liftedAt), gt(probeBans.expiresAt, now)))
      : Promise.resolve([] as { ip: string }[]),
  ]);
  const banned = new Set(activeIps.map((r) => r.ip));
  const blocks = await guardBlocks([...pathRows, ...earlierRows].flatMap((r) => (r.appId ? [r.appId] : []))).catch(() => new Map());
  const labelFor = pathLabeler(blocks);
  const { byApp } = probeCategories(pathRows, labelFor);
  const rules = ruleHitRows({ counts: counted.counts, events: earlierRows, details: details.values(), labelFor });
  const eventHits = earlierRows.reduce((s, r) => s + r.count, 0);
  const recorded = pathRows.reduce((s, r) => s + r.count, 0);

  return {
    range,
    label: rangeLabel(range, now, first.any),
    phrase: rangePhrase(range, now, first.any),
    since,
    // Counters hold no addresses, so older exempt hits come off by the events recorded for them.
    stats: { probes: Math.max(probes - exempt.count, recorded), bans, traps, permanent },
    bans: banRows.map((b) => ({
      ...b,
      status: banStatus(b, now),
      detail: details.get(b.id) ?? null,
      reportedTo: reports.get(b.id) ?? null,
    })),
    categories: rules.map((r) => ({ label: r.label, count: r.hits })),
    rules,
    probedNote: approximateNote(until, eventHits),
    byApp: appId ? [] : byApp,
    sources: sourceRows.map((s) => ({ ...s, banned: banned.has(s.ip) })),
    note: detailsStartNote({ start: since, earliestEvent: first.event, ...(buckets.unit === "day" ? { days } : { probes, recorded }) }),
  };
}
