// Drains the abuse report queue every 30 seconds, so request handlers never wait on a reporter.

import { and, gt, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains, organizations, probeEvents, projects } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { redis } from "@/lib/redis";
import { KeyedCooldown, RedisCooldownStore } from "@/lib/net/cooldown";
import { getInstanceConfig } from "@/lib/system-settings";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { activeBanFor, neverBanContext } from "../bans";
import { recordEvent } from "../events";
import { getProbeGuardSettings } from "../instance";
import { getAbuseApiKey, getAbuseSettings, updateAbuseStatus } from "../abuse-store";
import { draftReport } from "./draft";
import { drainReports, type DrainDeps } from "./drain";
import { defaultReportStore } from "./queue";
import { getReporter } from "./registry";
import { sensitiveTerms } from "./sanitize";

const log = logger.child("abuse-report");

const TERMS_TTL_MS = 5 * 60_000;
let terms: { at: number; value: string[] } | null = null;

/** Every host and name on this instance, so no report can carry one. */
async function instanceTerms(): Promise<string[]> {
  if (terms && Date.now() - terms.at < TERMS_TTL_MS) return terms.value;
  const [hosts, appNames, projectNames, orgNames, config] = await Promise.all([
    db.select({ domain: domains.domain }).from(domains),
    db.select({ name: apps.name, displayName: apps.displayName }).from(apps),
    db.select({ name: projects.name, displayName: projects.displayName }).from(projects),
    db.select({ name: organizations.name, slug: organizations.slug }).from(organizations),
    getInstanceConfig().catch(() => null),
  ]);
  const value = sensitiveTerms({
    hosts: [...hosts.map((h) => h.domain), config?.domain, config?.baseDomain, process.env.VARDO_DOMAIN],
    names: [
      ...appNames.flatMap((a) => [a.name, a.displayName]),
      ...projectNames.flatMap((p) => [p.name, p.displayName]),
      ...orgNames.flatMap((o) => [o.name, o.slug]),
      config?.instanceName,
    ],
  });
  terms = { at: Date.now(), value };
  return value;
}

async function loadDraft(ip: string, now: Date) {
  const windowMs = (await getProbeGuardSettings()).windowMinutes * 60_000;
  const ban = await activeBanFor(ip, now);
  const anchor = Math.min(ban?.createdAt.getTime() ?? now.getTime(), now.getTime());
  const events = await db
    .select({ ip: probeEvents.ip, kind: probeEvents.kind, path: probeEvents.path, createdAt: probeEvents.createdAt, appId: probeEvents.appId })
    .from(probeEvents)
    .where(and(
      eq(probeEvents.ip, ip),
      gt(probeEvents.createdAt, new Date(anchor - windowMs - 60_000)),
      inArray(probeEvents.kind, ["probe", "trap", "canary_used"]),
    ));
  const report = draftReport({ ip, ban, events, windowMs, now, terms: await instanceTerms() });
  if (!report) return null;
  return { report, appId: ban?.appId ?? events.find((e) => e.appId)?.appId ?? null };
}

const cooldown = new KeyedCooldown({ baseMs: 60_000, maxMs: 6 * 3_600_000, maxHoldMs: 24 * 3_600_000, store: new RedisCooldownStore(redis, "abuse-report:cooldown:") });

async function deps(): Promise<DrainDeps | null> {
  const reporter = getReporter();
  if (!reporter) return null;
  return {
    store: await defaultReportStore(),
    cooldown,
    reporter,
    settings: getAbuseSettings,
    apiKey: getAbuseApiKey,
    neverBanContext,
    draft: loadDraft,
    recordReported: (ip, appId, reporterId) => recordEvent({ kind: "reported", ip, path: reporterId, appId }),
    setStatus: ({ error, reportedAt }) =>
      updateAbuseStatus((s) => ({
        ...s,
        reporting: {
          lastError: error,
          lastErrorAt: error ? new Date().toISOString() : s.reporting.lastErrorAt,
          lastReportedAt: reportedAt ? reportedAt.toISOString() : s.reporting.lastReportedAt,
        },
      })),
  };
}

export const abuseReportLoop = new IntervalLoop({
  name: "abuse-report",
  intervalMs: 30_000,
  log,
  run: async () => {
    const d = await deps();
    if (!d) return;
    const result = await drainReports(d);
    if (result.sent > 0) log.info(`Reported ${result.sent} address${result.sent === 1 ? "" : "es"} to ${d.reporter.label}`);
  },
});
