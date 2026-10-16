// Counts and lists for the app Security tab and the admin view.

import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains, probeBans, probeEvents } from "@/lib/db/schema";
import { safeFetch } from "@/lib/security/safe-fetch";
import { bansSince, listActiveBans, permanentBanCount, type BanView } from "./bans";
import { banDetails } from "./ban-detail";
import { getProbeGuardSettings } from "./instance";
import type { BanDetail } from "./summary";
import { hitsThisWeek } from "./hits";
import { trapsSince } from "./events";
import { exemptProbeEvents } from "./exempt-events";
import { detectWordPress } from "./suggestions";

const WEEK_MS = 7 * 86_400_000;

export type GuardStats = { probes: number; bans: number; traps: number; permanent: number };

export async function weekStats(appId?: string, now = new Date()): Promise<GuardStats> {
  const since = new Date(now.getTime() - WEEK_MS);
  const [probes, exempt, bans, traps, permanent] = await Promise.all([
    hitsThisWeek(appId ?? null, now).catch(() => 0),
    exemptProbeEvents(since, appId).catch(() => ({ count: 0 })),
    bansSince(since, appId),
    trapsSince(since, appId),
    permanentBanCount(appId),
  ]);
  return { probes: Math.max(0, probes - exempt.count), bans, traps, permanent };
}

/** `reportedTo` is the reporter id that took a report since the ban began. */
export type BanWithDetail = BanView & { detail: BanDetail | null; reportedTo: string | null; banRank: number | null };
export type GuardOverview = { stats: GuardStats; bans: BanWithDetail[] };

const REPORT_SLACK_MS = 5 * 60_000;

/** The reporter each ban's address went to after the ban began, keyed by ban id. */
export async function banReports(bans: readonly { id: string; ip: string; createdAt: Date }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (bans.length === 0) return out;
  const since = new Date(Math.min(...bans.map((b) => b.createdAt.getTime())) - REPORT_SLACK_MS);
  const rows = await db
    .select({ ip: probeEvents.ip, path: probeEvents.path, createdAt: probeEvents.createdAt })
    .from(probeEvents)
    .where(and(eq(probeEvents.kind, "reported"), gt(probeEvents.createdAt, since), inArray(probeEvents.ip, [...new Set(bans.map((b) => b.ip))])));
  for (const ban of bans) {
    const hit = rows.find((r) => r.ip === ban.ip && r.path && r.createdAt.getTime() >= ban.createdAt.getTime() - REPORT_SLACK_MS);
    if (hit?.path) out.set(ban.id, hit.path);
  }
  return out;
}

export async function guardOverview(appId?: string): Promise<GuardOverview> {
  const [stats, bans, settings] = await Promise.all([weekStats(appId), listActiveBans({ appId }), getProbeGuardSettings()]);
  const [details, reports, ranks] = await Promise.all([
    banDetails(bans, settings.windowMinutes * 60_000).catch(() => new Map<string, BanDetail>()),
    banReports(bans).catch(() => new Map<string, string>()),
    banRanksByAddress(bans).catch(() => new Map<string, number>()),
  ]);
  return {
    stats,
    bans: bans.map((b) => ({
      ...b,
      detail: details.get(b.id) ?? null,
      reportedTo: reports.get(b.id) ?? null,
      banRank: ranks.get(b.id) ?? null,
    })),
  };
}

/** Where each ban sits in its address's recent sequence, oldest first. One round trip. */
export async function banRanksByAddress(
  bans: readonly { id: string; ip: string; createdAt: Date }[],
  windowMs = 30 * 86_400_000,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (bans.length === 0) return out;
  const ips = [...new Set(bans.map((b) => b.ip))];
  const earliest = Math.min(...bans.map((b) => b.createdAt.getTime())) - windowMs;
  const rows = await db
    .select({ id: probeBans.id, ip: probeBans.ip, createdAt: probeBans.createdAt })
    .from(probeBans)
    .where(and(inArray(probeBans.ip, ips), gt(probeBans.createdAt, new Date(earliest))))
    .orderBy(probeBans.createdAt);
  const perIp = new Map<string, { id: string; createdAt: Date }[]>();
  for (const row of rows) {
    const list = perIp.get(row.ip);
    if (list) list.push(row);
    else perIp.set(row.ip, [row]);
  }
  for (const ban of bans) {
    out.set(ban.id, extractBanRank(ban, rows, windowMs));
  }
  return out;
}

/** Default 30-day window for ranking a ban among its address's recent ones. */
export const RANK_WINDOW_MS = 30 * 86_400_000;

/** The ordinal position of `target` among the same address's bans in the last `windowMs`, oldest first. Returns 0 if not found. */
export function extractBanRank(
  target: { id: string; ip: string; createdAt: Date },
  bans: readonly { id: string; ip: string; createdAt: Date }[],
  windowMs = RANK_WINDOW_MS,
): number {
  const earliest = target.createdAt.getTime() - windowMs;
  const sequence = bans
    .filter((b) => b.ip === target.ip && b.createdAt.getTime() >= earliest)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return sequence.findIndex((b) => b.id === target.id) + 1;
}

/** The ordinal position of this ban among the same address's bans in the last `windowMs`, oldest first. 1 means the first ban in the window. */
export async function banRankInPeriod(
  ban: { id: string; ip: string; createdAt: Date },
  windowMs = 30 * 86_400_000,
): Promise<number> {
  const since = new Date(ban.createdAt.getTime() - windowMs);
  const rows = await db
    .select({ id: probeBans.id, ip: probeBans.ip, createdAt: probeBans.createdAt })
    .from(probeBans)
    .where(and(eq(probeBans.ip, ban.ip), gt(probeBans.createdAt, since)))
    .orderBy(probeBans.createdAt);
  return extractBanRank(ban, rows, windowMs);
}

/** Whether the app looks like WordPress from its image, template or compose file. */
export async function appLooksLikeWordPress(appId: string): Promise<boolean> {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
    columns: { imageName: true, templateName: true, composeContent: true },
  });
  if (!app) return false;
  const children = await db.select({ imageName: apps.imageName }).from(apps).where(eq(apps.parentAppId, appId));
  return detectWordPress({ ...app, childImages: children.map((c) => c.imageName) });
}

/** Whether the app answers /robots.txt itself. Checked before Vardo takes it over; unknown counts as no. */
export async function appServesOwnRobots(appId: string): Promise<boolean> {
  const [domain] = await db
    .select({ domain: domains.domain })
    .from(domains)
    .where(and(eq(domains.appId, appId), isNull(domains.pathPrefix)))
    .limit(1);
  if (!domain || domain.domain.startsWith("*.")) return false;
  try {
    const res = await safeFetch(`https://${domain.domain}/robots.txt`, { signal: AbortSignal.timeout(5000), maxRedirects: 0 });
    const type = res.headers.get("content-type") ?? "";
    const body = res.ok && type.startsWith("text/plain") ? await res.text() : "";
    return /^\s*(user-agent|disallow|allow|sitemap)\s*:/im.test(body);
  } catch {
    return false;
  }
}
