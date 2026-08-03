import "server-only";

import { and, desc, eq, gte, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { queryLogCounts, storeLogCounts } from "@/lib/metrics/store-errors";
import { redis } from "@/lib/redis";
import {
  BASELINE_MS,
  SAMPLE_MS,
  STALE_AFTER_MS,
  errorRateReading,
  quietWindows,
  type ErrorRateReading,
  type QuietWindow,
} from "@/lib/ui/error-rate";
import { isLokiAvailable, queryInstant } from "./client";
import { attributeCounts, errorCountQuery, lineCountQuery } from "./error-shape";

const log = logger.child("error-rate");

/** Elevated apps, cached by the collector so the attention bar costs one read. */
const ELEVATED_KEY = "logs:error-rate:elevated";

export type ElevatedApp = { appId: string; recent: number; baseline: number };

type SampledApp = {
  id: string;
  organizationId: string;
  parentAppId: string | null;
  composeService: string | null;
  containerStartedAt: Date | null;
};

/**
 * One tick: count matching and total lines per organization, write a sample per
 * running app, then cache which apps have stepped up.
 *
 * Loki is tenanted by organization, so the fleet takes one pair of queries per
 * organization. An organization whose queries fail is skipped rather than
 * sampled at zero, which would read as a quiet app instead of a missing one.
 *
 * Every running app in an organization that answered gets a sample even when
 * Loki reported nothing for it, so a quiet app builds a real baseline of zeros.
 * An app that is not running gets none, which is what keeps its last rate from
 * reading as the current one.
 */
export async function collectErrorRates(): Promise<number> {
  if (!(await isLokiAvailable())) return 0;

  const running = await db
    .select({
      id: apps.id,
      organizationId: apps.organizationId,
      parentAppId: apps.parentAppId,
      composeService: apps.composeService,
      containerStartedAt: apps.containerStartedAt,
    })
    .from(apps)
    .where(eq(apps.status, "active"));

  if (running.length === 0) return 0;

  const seconds = Math.round(SAMPLE_MS / 1000);
  const sampled: SampledApp[] = [];
  const errorCounts = new Map<string, number>();
  const lineCounts = new Map<string, number>();

  for (const [organizationId, orgApps] of groupByOrganization(running)) {
    try {
      const [errors, lines] = await Promise.all([
        queryInstant(errorCountQuery(seconds), organizationId),
        queryInstant(lineCountQuery(seconds), organizationId),
      ]);
      for (const [id, count] of attributeCounts(errors, orgApps)) errorCounts.set(id, count);
      for (const [id, count] of attributeCounts(lines, orgApps)) lineCounts.set(id, count);
      sampled.push(...orgApps);
    } catch (err) {
      log.error(`Log counts failed for organization ${organizationId}:`, err);
    }
  }

  if (sampled.length === 0) return 0;

  // One grid for every app, so windows line up and gaps are visible as gaps.
  const at = Math.floor(Date.now() / SAMPLE_MS) * SAMPLE_MS;

  const results = await Promise.allSettled(
    sampled.map((app) =>
      storeLogCounts(
        app.id,
        at,
        { errors: errorCounts.get(app.id) ?? 0, lines: lineCounts.get(app.id) ?? 0 },
        app.organizationId,
      ),
    ),
  );

  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    log.error(`${sampled.length - failed} samples stored, ${failed} failed`);
  }

  await cacheElevated(sampled, at);
  return sampled.length - failed;
}

/** Running apps keyed by the tenant their logs live in. */
function groupByOrganization(running: SampledApp[]): Map<string, SampledApp[]> {
  const byOrg = new Map<string, SampledApp[]>();
  for (const app of running) {
    const list = byOrg.get(app.organizationId) ?? [];
    list.push(app);
    byOrg.set(app.organizationId, list);
  }
  return byOrg;
}

/** Deploys and container restarts that make a window unjudgeable, per app. */
async function loadQuietWindows(appIds: string[], since: number): Promise<Map<string, QuietWindow[]>> {
  if (appIds.length === 0) return new Map();

  const rows = await db
    .select({
      appId: deployments.appId,
      startedAt: deployments.startedAt,
      finishedAt: deployments.finishedAt,
    })
    .from(deployments)
    .where(and(inArray(deployments.appId, appIds), gte(deployments.startedAt, new Date(since))))
    .orderBy(desc(deployments.startedAt));

  const byApp = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byApp.get(row.appId) ?? [];
    list.push(row);
    byApp.set(row.appId, list);
  }

  return new Map([...byApp].map(([appId, list]) => [appId, quietWindows(list, [])]));
}

/**
 * A child service has no deploy rows of its own — its containers are brought up
 * by the parent's deploy, so the parent's windows apply to it too.
 */
function quietFor(
  app: { id: string; parentAppId: string | null; containerStartedAt: Date | null },
  byApp: Map<string, QuietWindow[]>,
): QuietWindow[] {
  return [
    ...(byApp.get(app.id) ?? []),
    ...(app.parentAppId ? byApp.get(app.parentAppId) ?? [] : []),
    ...quietWindows([], [app.containerStartedAt]),
  ];
}

async function cacheElevated(running: SampledApp[], now: number): Promise<void> {
  const deployIds = running.map((a) => a.parentAppId ?? a.id);
  const byApp = await loadQuietWindows([...new Set(deployIds)], now - BASELINE_MS);

  const elevated: ElevatedApp[] = [];
  for (const app of running) {
    try {
      const samples = await queryLogCounts(app.id, now - BASELINE_MS, now);
      const reading = errorRateReading({ now, samples, quiet: quietFor(app, byApp) });
      if (reading.status === "elevated" && reading.recent !== null) {
        elevated.push({ appId: app.id, recent: reading.recent, baseline: reading.baseline ?? 0 });
      }
    } catch {
      // Best effort — a missing app reads as not elevated, never as elevated.
    }
  }

  try {
    await redis.set(ELEVATED_KEY, JSON.stringify(elevated), "PX", STALE_AFTER_MS);
  } catch (err) {
    log.warn("Could not cache elevated apps:", (err as Error).message);
  }
}

/** Apps the last tick judged elevated. Empty when the collector is not running. */
export async function getElevatedApps(): Promise<ElevatedApp[]> {
  try {
    const raw = await redis.get(ELEVATED_KEY);
    return raw ? (JSON.parse(raw) as ElevatedApp[]) : [];
  } catch {
    return [];
  }
}

export type ErrorRateResult = {
  reading: ErrorRateReading;
  /** The stored samples the reading was built from, oldest first. */
  samples: { at: number; errors: number; lines: number }[];
};

/** One app's reading, with the samples behind it for the tab to chart. */
export async function readErrorRate(app: {
  id: string;
  parentAppId: string | null;
  containerStartedAt: Date | null;
}): Promise<ErrorRateResult> {
  const now = Date.now();
  const deployIds = [...new Set([app.id, app.parentAppId].filter((id): id is string => !!id))];
  const [samples, byApp] = await Promise.all([
    queryLogCounts(app.id, now - BASELINE_MS, now),
    loadQuietWindows(deployIds, now - BASELINE_MS),
  ]);

  return { reading: errorRateReading({ now, samples, quiet: quietFor(app, byApp) }), samples };
}
