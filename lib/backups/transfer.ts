import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, backupJobApps, backupJobs, backups } from "@/lib/db/schema";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { logger } from "@/lib/logger";
import { ensureAutoBackupJob } from "./auto-backup";

const log = logger.child("backups");

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type MovedApp = { id: string; name: string };

/** Take these apps out of the org's backup jobs and delete their emptied "Auto:" jobs. */
export async function releaseAppsFromOrgJobs(
  tx: Tx,
  orgId: string,
  moved: MovedApp[],
): Promise<{ unlinked: number; deletedJobIds: string[] }> {
  const appIds = moved.map((a) => a.id);
  if (appIds.length === 0) return { unlinked: 0, deletedJobIds: [] };

  const jobs = await tx
    .select({ id: backupJobs.id, name: backupJobs.name })
    .from(backupJobs)
    .where(eq(backupJobs.organizationId, orgId));
  if (jobs.length === 0) return { unlinked: 0, deletedJobIds: [] };
  const jobIds = jobs.map((j) => j.id);

  const unlinked = await tx
    .delete(backupJobApps)
    .where(and(inArray(backupJobApps.appId, appIds), inArray(backupJobApps.backupJobId, jobIds)))
    .returning({ jobId: backupJobApps.backupJobId });

  // The history moves with the app; the old org's jobs stop pruning it.
  await tx
    .update(backups)
    .set({
      jobId: null,
      jobName: sql`coalesce(${backups.jobName}, (select "name" from "backup_job" where "backup_job"."id" = "backup"."job_id"))`,
    })
    .where(and(inArray(backups.appId, appIds), inArray(backups.jobId, jobIds)));

  const autoNames = new Set(moved.map((a) => `Auto: ${a.name}`));
  const touched = new Set(unlinked.map((u) => u.jobId));
  const autoJobIds = jobs.filter((j) => touched.has(j.id) && autoNames.has(j.name)).map((j) => j.id);
  if (autoJobIds.length === 0) return { unlinked: unlinked.length, deletedJobIds: [] };

  const deleted = await tx
    .delete(backupJobs)
    .where(
      and(
        inArray(backupJobs.id, autoJobIds),
        sql`not exists (select 1 from "backup_job_app" where "backup_job_app"."backup_job_id" = "backup_job"."id")`,
        sql`not exists (select 1 from "backup_job_volume" where "backup_job_volume"."backup_job_id" = "backup_job"."id")`,
      ),
    )
    .returning({ id: backupJobs.id });

  return { unlinked: unlinked.length, deletedJobIds: deleted.map((d) => d.id) };
}

/** Give each app the backup coverage a new app in the org gets. Never throws. */
export async function coverAppsInOrg(orgId: string, moved: MovedApp[]): Promise<string[]> {
  if (!(await isFeatureEnabledAsync("backups"))) return [];
  const created: string[] = [];
  for (const app of moved) {
    try {
      const jobId = await ensureAutoBackupJob({ appId: app.id, appName: app.name, organizationId: orgId });
      if (jobId) created.push(jobId);
    } catch (err) {
      log.error(`Backup coverage for transferred app ${app.name} failed:`, err);
    }
  }
  return created;
}

/** Release apps from another org's jobs, then cover them in their own org. */
export async function repairForeignJobLinks(): Promise<number> {
  const stale = await db
    .select({ jobOrgId: backupJobs.organizationId, appId: apps.id, appName: apps.name, appOrgId: apps.organizationId })
    .from(backupJobApps)
    .innerJoin(backupJobs, eq(backupJobs.id, backupJobApps.backupJobId))
    .innerJoin(apps, eq(apps.id, backupJobApps.appId))
    .where(and(isNotNull(backupJobs.organizationId), ne(backupJobs.organizationId, apps.organizationId)));
  if (stale.length === 0) return 0;

  const byJobOrg = new Map<string, MovedApp[]>();
  const byAppOrg = new Map<string, Map<string, MovedApp>>();
  for (const row of stale) {
    const app = { id: row.appId, name: row.appName };
    byJobOrg.set(row.jobOrgId!, [...(byJobOrg.get(row.jobOrgId!) ?? []), app]);
    const own = byAppOrg.get(row.appOrgId) ?? new Map<string, MovedApp>();
    own.set(app.id, app);
    byAppOrg.set(row.appOrgId, own);
  }

  let unlinked = 0;
  for (const [orgId, moved] of byJobOrg) {
    unlinked += (await db.transaction((tx) => releaseAppsFromOrgJobs(tx, orgId, moved))).unlinked;
  }
  for (const [orgId, own] of byAppOrg) await coverAppsInOrg(orgId, [...own.values()]);
  return unlinked;
}
