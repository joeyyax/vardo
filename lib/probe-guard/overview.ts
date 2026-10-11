// Counts and lists for the app Security tab and the admin view.

import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains, probeEvents } from "@/lib/db/schema";
import { safeFetch } from "@/lib/security/safe-fetch";
import { bansSince, listActiveBans, permanentBanCount, type BanView } from "./bans";
import { banDetails } from "./ban-detail";
import { getProbeGuardSettings } from "./instance";
import type { BanDetail } from "./summary";
import { hitsThisWeek } from "./hits";
import { trapsSince } from "./events";
import { detectWordPress } from "./settings";

const WEEK_MS = 7 * 86_400_000;

export type GuardStats = { probes: number; bans: number; traps: number; permanent: number };

export async function weekStats(appId?: string, now = new Date()): Promise<GuardStats> {
  const since = new Date(now.getTime() - WEEK_MS);
  const [probes, bans, traps, permanent] = await Promise.all([
    hitsThisWeek(appId ?? null, now).catch(() => 0),
    bansSince(since, appId),
    trapsSince(since, appId),
    permanentBanCount(appId),
  ]);
  return { probes, bans, traps, permanent };
}

/** `reportedTo` is the reporter id that took a report since the ban began. */
export type BanWithDetail = BanView & { detail: BanDetail | null; reportedTo: string | null };
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
  const [details, reports] = await Promise.all([
    banDetails(bans, settings.windowMinutes * 60_000).catch(() => new Map<string, BanDetail>()),
    banReports(bans).catch(() => new Map<string, string>()),
  ]);
  return { stats, bans: bans.map((b) => ({ ...b, detail: details.get(b.id) ?? null, reportedTo: reports.get(b.id) ?? null })) };
}

/** Whether the app looks like WordPress to auto-detection. */
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
