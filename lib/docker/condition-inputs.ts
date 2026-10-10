// Cached backup, security and certificate inputs for the health monitor's conditions.

import { desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  apps,
  appSecurityScans,
  backupJobApps,
  backupJobs,
  domainCertChecks,
  domains,
  volumes,
} from "@/lib/db/schema";
import { appsWithBackupState, type SelectableVolume } from "@/lib/backups/selection";
import type { ConditionInput } from "./conditions";

export type AdvisoryInput = {
  security: ConditionInput["security"];
  backup: ConditionInput["backup"];
  cert: ConditionInput["cert"];
};

/** How long a loaded snapshot stays usable. */
export const ADVISORY_TTL_MS = 5 * 60_000;

let cache: { at: number; byApp: Map<string, AdvisoryInput> } | null = null;

/** Test seam. */
export function clearAdvisoryCache(): void {
  cache = null;
}

/** Backup, security and cert state per app, cached for ADVISORY_TTL_MS. Never throws. */
export async function loadAdvisoryInputs(now: number): Promise<Map<string, AdvisoryInput>> {
  if (cache && now - cache.at < ADVISORY_TTL_MS) return cache.byApp;

  const byApp = new Map<string, AdvisoryInput>();
  try {
    const appRows = await db
      .select({ id: apps.id, organizationId: apps.organizationId, persistentVolumes: apps.persistentVolumes, parked: apps.parked })
      .from(apps);

    const jobRows = await db
      .select({
        appId: backupJobApps.appId,
        jobOrgId: backupJobs.organizationId,
        enabled: backupJobs.enabled,
        lastRunAt: backupJobs.lastRunAt,
      })
      .from(backupJobApps)
      .innerJoin(backupJobs, eq(backupJobApps.backupJobId, backupJobs.id));
    const { covered, lastRunByApp } = backupCoverage(appRows, jobRows);

    const volumeRows = await db
      .select({
        id: volumes.id,
        appId: volumes.appId,
        appName: apps.name,
        name: volumes.name,
        mountPath: volumes.mountPath,
        type: volumes.type,
        source: volumes.source,
        persistent: volumes.persistent,
        durability: volumes.durability,
        backupStrategy: volumes.backupStrategy,
        backupSelection: volumes.backupSelection,
      })
      .from(volumes)
      .innerJoin(apps, eq(apps.id, volumes.appId));
    const { readHostMounts } = await import("@/lib/backups/enroll");
    const withState = appsWithBackupState(
      volumeRows as (SelectableVolume & { appName: string })[],
      await readHostMounts(),
    );

    const scanByApp = await latestScans(appRows.map((a) => a.id));
    const certByApp = soonestCertPerApp(
      await db
        .select({
          appId: domains.appId,
          domain: domains.domain,
          sslEnabled: domains.sslEnabled,
          expiresAt: domainCertChecks.expiresAt,
          checkedAt: domainCertChecks.checkedAt,
        })
        .from(domainCertChecks)
        .innerJoin(domains, eq(domainCertChecks.domainId, domains.id)),
    );

    for (const app of appRows) {
      byApp.set(app.id, {
        security: scanByApp.get(app.id) ?? null,
        // A parked app is off on purpose; its backups don't go stale.
        backup: app.parked
          ? null
          : {
              hasVolumes: withState.has(app.id) || (app.persistentVolumes?.length ?? 0) > 0,
              configured: covered.has(app.id),
              lastRunAt: lastRunByApp.get(app.id) ?? null,
            },
        cert: certByApp.get(app.id) ?? null,
      });
    }
  } catch {
    return cache?.byApp ?? new Map();
  }

  cache = { at: now, byApp };
  return byApp;
}

export type BackupJobLinkRow = {
  appId: string;
  jobOrgId: string | null;
  enabled: boolean;
  lastRunAt: Date | null;
};

/** Apps covered by an enabled own-org or instance-level job, with the latest run across those jobs. */
export function backupCoverage(
  appRows: { id: string; organizationId: string }[],
  jobRows: BackupJobLinkRow[],
): { covered: Set<string>; lastRunByApp: Map<string, number | null> } {
  const orgByApp = new Map(appRows.map((a) => [a.id, a.organizationId]));
  const covered = new Set<string>();
  const lastRunByApp = new Map<string, number | null>();
  for (const row of jobRows) {
    if (!row.enabled) continue;
    if (row.jobOrgId !== null && row.jobOrgId !== orgByApp.get(row.appId)) continue;
    covered.add(row.appId);
    const ts = row.lastRunAt ? row.lastRunAt.getTime() : null;
    const seen = lastRunByApp.get(row.appId);
    if (seen === undefined || (ts !== null && (seen === null || ts > seen))) {
      lastRunByApp.set(row.appId, ts);
    }
  }
  return { covered, lastRunByApp };
}

export type CertCheckRow = {
  appId: string;
  domain: string;
  sslEnabled: boolean | null;
  expiresAt: Date | null;
  checkedAt: Date;
};

/** The soonest-expiring certificate per app. Skips TLS-off domains and unreadable certs. */
export function soonestCertPerApp(
  rows: CertCheckRow[],
): Map<string, NonNullable<ConditionInput["cert"]>> {
  const out = new Map<string, NonNullable<ConditionInput["cert"]>>();
  for (const row of rows) {
    if (row.sslEnabled === false || row.expiresAt === null) continue;
    const candidate = {
      domain: row.domain,
      expiresAt: row.expiresAt.getTime(),
      checkedAt: row.checkedAt.getTime(),
    };
    const seen = out.get(row.appId);
    if (!seen || candidate.expiresAt < seen.expiresAt) out.set(row.appId, candidate);
  }
  return out;
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
    // Newest first; first per app wins.
    if (out.has(row.appId)) continue;
    out.set(row.appId, { critical: row.criticalCount, warning: row.warningCount });
  }
  return out;
}
