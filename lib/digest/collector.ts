import { db } from "@/lib/db";
import {
  apps,
  backups,
  cronJobs,
  cronJobRuns,
  deployments,
  activities,
} from "@/lib/db/schema";
import { eq, and, gte, inArray, count, sql } from "drizzle-orm";
import type {
  DigestDeploySummary,
  DigestBackupSummary,
  DigestCronSummary,
  DigestAlertSummary,
  DigestProjectRow,
} from "@/lib/email/templates/weekly-digest";

export type DigestData = {
  orgName: string;
  weekLabel: string;
  deploys: DigestDeploySummary;
  backups: DigestBackupSummary;
  cron: DigestCronSummary;
  alerts: DigestAlertSummary;
  projects: DigestProjectRow[];
};

/**
 * Collect past 7 days of health data for a given org.
 */
export async function collectDigestData(
  orgId: string,
  orgName: string,
): Promise<DigestData> {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Week label e.g. "Mar 14 – Mar 20, 2026"
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const weekLabel = `${fmt(since)} – ${fmt(now)}, ${now.getFullYear()}`;

  // All apps in org
  const orgApps = await db.query.apps.findMany({
    where: eq(apps.organizationId, orgId),
    columns: { id: true, name: true, projectId: true },
  });

  if (orgApps.length === 0) {
    return {
      orgName,
      weekLabel,
      deploys: { total: 0, succeeded: 0, failed: 0 },
      backups: { total: 0, succeeded: 0, failed: 0 },
      cron: { totalFailures: 0, affectedJobs: [] },
      alerts: { diskWriteAlerts: 0, volumeDrifts: 0 },
      projects: [],
    };
  }

  const appIds = orgApps.map((a) => a.id);

  // Fetch cron job ids scoped to this org's apps (needed before Promise.all)
  const orgCronJobs = await db.query.cronJobs.findMany({
    where: inArray(cronJobs.appId, appIds),
    columns: { id: true, name: true, appId: true },
  });

  const orgCronJobIds = orgCronJobs.map((j) => j.id);

  // ---------------------------------------------------------------------------
  // Run remaining queries in parallel
  // ---------------------------------------------------------------------------
  const [
    deployCountRows,
    backupCountRows,
    cronRuns,
    alertCountRows,
  ] = await Promise.all([
    // Deployment counts grouped by status — no full row loads
    db
      .select({ status: deployments.status, n: count() })
      .from(deployments)
      .where(
        and(
          inArray(deployments.appId, appIds),
          gte(deployments.startedAt, since),
        ),
      )
      .groupBy(deployments.status),

    // Backup counts grouped by status — no full row loads
    db
      .select({ status: backups.status, n: count() })
      .from(backups)
      .where(
        and(
          inArray(backups.appId, appIds),
          gte(backups.startedAt, since),
        ),
      )
      .groupBy(backups.status),

    // Cron runs — only fetch if there are cron jobs; keep full rows for
    // per-project breakdown (cronJobId needed)
    orgCronJobIds.length > 0
      ? db.query.cronJobRuns.findMany({
          where: and(
            inArray(cronJobRuns.cronJobId, orgCronJobIds),
            gte(cronJobRuns.startedAt, since),
          ),
          columns: {
            id: true,
            cronJobId: true,
            status: true,
          },
        })
      : Promise.resolve([]),

    // Alert counts — filter by action at the DB level
    db
      .select({ action: activities.action, n: count() })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, orgId),
          gte(activities.createdAt, since),
          inArray(activities.action, ["disk-write-alert", "volume-drift"]),
        ),
      )
      .groupBy(activities.action),
  ]);

  // ---------------------------------------------------------------------------
  // Aggregate deploy counts
  // ---------------------------------------------------------------------------
  let deployTotal = 0;
  let deploySucceeded = 0;
  let deployFailed = 0;
  for (const row of deployCountRows) {
    deployTotal += row.n;
    if (row.status === "success") deploySucceeded = row.n;
    if (row.status === "failed") deployFailed = row.n;
  }

  // ---------------------------------------------------------------------------
  // Aggregate backup counts
  // ---------------------------------------------------------------------------
  let backupTotal = 0;
  let backupSucceeded = 0;
  let backupFailed = 0;
  for (const row of backupCountRows) {
    backupTotal += row.n;
    if (row.status === "success") backupSucceeded = row.n;
    if (row.status === "failed") backupFailed = row.n;
  }

  // ---------------------------------------------------------------------------
  // Cron failures
  // ---------------------------------------------------------------------------
  const cronJobById = new Map(orgCronJobs.map((j) => [j.id, j]));

  const failedCronRuns = cronRuns.filter((r) => r.status === "failed");
  const affectedJobNames = [
    ...new Set(
      failedCronRuns
        .map((r) => cronJobById.get(r.cronJobId)?.name)
        .filter((n): n is string => Boolean(n)),
    ),
  ];

  // ---------------------------------------------------------------------------
  // Alert counts (already aggregated from DB)
  // ---------------------------------------------------------------------------
  let diskWriteAlerts = 0;
  let volumeDrifts = 0;
  for (const row of alertCountRows) {
    if (row.action === "disk-write-alert") diskWriteAlerts = row.n;
    if (row.action === "volume-drift") volumeDrifts = row.n;
  }

  // ---------------------------------------------------------------------------
  // Per-project breakdown
  // ---------------------------------------------------------------------------
  const projectMap = new Map<string, DigestProjectRow>();

  for (const app of orgApps) {
    const projectKey = app.projectId ?? `__no_project_${app.id}`;
    if (!projectMap.has(projectKey)) {
      projectMap.set(projectKey, {
        name: app.name,
        deploys: 0,
        failures: 0,
        backupFailures: 0,
        cronFailures: 0,
      });
    }
  }

  // For per-project deploy/backup breakdowns we need the appId → status rows.
  // Re-use the same time window but fetch only appId + status (lightweight).
  const [deployRows, backupRows] = await Promise.all([
    deployTotal > 0
      ? db
          .select({ appId: deployments.appId, status: deployments.status })
          .from(deployments)
          .where(
            and(
              inArray(deployments.appId, appIds),
              gte(deployments.startedAt, since),
            ),
          )
      : Promise.resolve([]),
    backupTotal > 0
      ? db
          .select({ appId: backups.appId, status: backups.status })
          .from(backups)
          .where(
            and(
              inArray(backups.appId, appIds),
              gte(backups.startedAt, since),
            ),
          )
      : Promise.resolve([]),
  ]);

  const appById = new Map(orgApps.map((a) => [a.id, a]));

  for (const dep of deployRows) {
    const app = appById.get(dep.appId);
    if (!app) continue;
    const projectKey = app.projectId ?? `__no_project_${app.id}`;
    const row = projectMap.get(projectKey);
    if (!row) continue;
    row.deploys += 1;
    if (dep.status === "failed") row.failures += 1;
  }

  for (const bk of backupRows) {
    if (!bk.appId) continue; // system backups don't belong to an app
    const app = appById.get(bk.appId);
    if (!app) continue;
    const projectKey = app.projectId ?? `__no_project_${app.id}`;
    const row = projectMap.get(projectKey);
    if (!row) continue;
    if (bk.status === "failed") row.backupFailures += 1;
  }

  for (const run of failedCronRuns) {
    const job = cronJobById.get(run.cronJobId);
    if (!job) continue;
    const app = appById.get(job.appId);
    if (!app) continue;
    const projectKey = app.projectId ?? `__no_project_${app.id}`;
    const row = projectMap.get(projectKey);
    if (!row) continue;
    row.cronFailures += 1;
  }

  // Only include projects that had activity
  const projects = [...projectMap.values()].filter(
    (p) => p.deploys > 0 || p.failures > 0 || p.backupFailures > 0 || p.cronFailures > 0,
  );

  return {
    orgName,
    weekLabel,
    deploys: {
      total: deployTotal,
      succeeded: deploySucceeded,
      failed: deployFailed,
    },
    backups: {
      total: backupTotal,
      succeeded: backupSucceeded,
      failed: backupFailed,
    },
    cron: {
      totalFailures: failedCronRuns.length,
      affectedJobs: affectedJobNames,
    },
    alerts: {
      diskWriteAlerts,
      volumeDrifts,
    },
    projects,
  };
}
