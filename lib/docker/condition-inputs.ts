// ---------------------------------------------------------------------------
// Advisory condition inputs
//
// Backup coverage and security findings change on the order of hours, so they
// are loaded on their own cadence and cached rather than queried on every
// health-monitor tick. The monitor stays the single writer of apps.conditions.
// ---------------------------------------------------------------------------

import { desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps, appSecurityScans, backupJobApps, backupJobs } from "@/lib/db/schema";
import type { ConditionInput } from "./conditions";

export type AdvisoryInput = {
  security: ConditionInput["security"];
  backup: ConditionInput["backup"];
};

/** How long a loaded snapshot stays usable. */
export const ADVISORY_TTL_MS = 5 * 60_000;

let cache: { at: number; byApp: Map<string, AdvisoryInput> } | null = null;

/** Test seam. */
export function clearAdvisoryCache(): void {
  cache = null;
}

/**
 * Backup and security state per app, cached for ADVISORY_TTL_MS. Returns an
 * empty map rather than throwing — a failed advisory read must not stop the
 * runtime conditions from being written.
 */
export async function loadAdvisoryInputs(now: number): Promise<Map<string, AdvisoryInput>> {
  if (cache && now - cache.at < ADVISORY_TTL_MS) return cache.byApp;

  const byApp = new Map<string, AdvisoryInput>();
  try {
    const appRows = await db
      .select({ id: apps.id, persistentVolumes: apps.persistentVolumes })
      .from(apps);

    const covered = new Set<string>();
    const lastRunByApp = new Map<string, number | null>();
    const jobRows = await db
      .select({
        appId: backupJobApps.appId,
        enabled: backupJobs.enabled,
        lastRunAt: backupJobs.lastRunAt,
      })
      .from(backupJobApps)
      .innerJoin(backupJobs, eq(backupJobApps.backupJobId, backupJobs.id));

    for (const row of jobRows) {
      if (!row.enabled) continue;
      covered.add(row.appId);
      // Most recent run across every job covering this app.
      const ts = row.lastRunAt ? row.lastRunAt.getTime() : null;
      const seen = lastRunByApp.get(row.appId);
      if (seen === undefined || (ts !== null && (seen === null || ts > seen))) {
        lastRunByApp.set(row.appId, ts);
      }
    }

    const scanByApp = await latestScans(appRows.map((a) => a.id));

    for (const app of appRows) {
      byApp.set(app.id, {
        security: scanByApp.get(app.id) ?? null,
        backup: {
          hasVolumes: (app.persistentVolumes?.length ?? 0) > 0,
          configured: covered.has(app.id),
          lastRunAt: lastRunByApp.get(app.id) ?? null,
        },
      });
    }
  } catch {
    return cache?.byApp ?? new Map();
  }

  cache = { at: now, byApp };
  return byApp;
}

/** Newest completed scan per app. */
async function latestScans(
  appIds: string[],
): Promise<Map<string, { critical: number; warning: number }>> {
  const out = new Map<string, { critical: number; warning: number }>();
  if (appIds.length === 0) return out;

  const rows = await db
    .select({
      appId: appSecurityScans.appId,
      criticalCount: appSecurityScans.criticalCount,
      warningCount: appSecurityScans.warningCount,
      startedAt: appSecurityScans.startedAt,
      status: appSecurityScans.status,
    })
    .from(appSecurityScans)
    .where(inArray(appSecurityScans.appId, appIds))
    .orderBy(desc(appSecurityScans.startedAt));

  for (const row of rows) {
    if (row.status !== "completed") continue;
    // Rows arrive newest first, so the first one per app wins.
    if (out.has(row.appId)) continue;
    out.set(row.appId, { critical: row.criticalCount, warning: row.warningCount });
  }
  return out;
}
