// Counts and lists for the app Security tab and the admin view.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains } from "@/lib/db/schema";
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

export type BanWithDetail = BanView & { detail: BanDetail | null };
export type GuardOverview = { stats: GuardStats; bans: BanWithDetail[] };

export async function guardOverview(appId?: string): Promise<GuardOverview> {
  const [stats, bans, settings] = await Promise.all([weekStats(appId), listActiveBans({ appId }), getProbeGuardSettings()]);
  const details = await banDetails(bans, settings.windowMinutes * 60_000).catch(() => new Map<string, BanDetail>());
  return { stats, bans: bans.map((b) => ({ ...b, detail: details.get(b.id) ?? null })) };
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
