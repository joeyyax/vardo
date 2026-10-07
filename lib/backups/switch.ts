// Backup switch: `app ?? org ?? system`. On enrolls the app; off disables its jobs. Archives stay.

import { db } from "@/lib/db";
import { apps, backupJobApps, backupJobs, organizations } from "@/lib/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { isVardoManagedApp } from "@/lib/infra/instance-apps";
import { logger } from "@/lib/logger";
import { resolveBackupTarget } from "./auto-backup";

const log = logger.child("backup-switch");

const SYSTEM_KEY = "backups_default";

export type BackupSwitchSource = "app" | "org" | "system";

export type ResolvedBackupSwitch = { enabled: boolean; source: BackupSwitchSource };

export function resolveBackupSwitch(
  app: boolean | null | undefined,
  org: boolean | null | undefined,
  system: boolean,
): ResolvedBackupSwitch {
  if (app != null) return { enabled: app, source: "app" };
  if (org != null) return { enabled: org, source: "org" };
  return { enabled: system, source: "system" };
}

/** On unless an instance admin turned it off. */
export async function getSystemBackupsDefault(): Promise<boolean> {
  return (await getSystemSettingRaw(SYSTEM_KEY)) !== "false";
}

export async function setSystemBackupsDefault(enabled: boolean): Promise<void> {
  await setSystemSetting(SYSTEM_KEY, enabled ? "true" : "false");
}

/** The switch for one app, read from the database. */
export async function resolveAppBackupSwitch(appId: string): Promise<ResolvedBackupSwitch | null> {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
    columns: { backupsEnabled: true },
    with: { organization: { columns: { backupsEnabled: true } } },
  });
  if (!app) return null;
  return resolveBackupSwitch(app.backupsEnabled, app.organization?.backupsEnabled, await getSystemBackupsDefault());
}

type OwnJob = { id: string; enabled: boolean; organizationId: string | null; appIds: string[]; volumeCount: number };

async function jobsCovering(appId: string, organizationId: string): Promise<OwnJob[]> {
  const links = await db.query.backupJobApps.findMany({
    where: eq(backupJobApps.appId, appId),
    with: {
      backupJob: {
        columns: { id: true, enabled: true, organizationId: true },
        with: { backupJobApps: { columns: { appId: true } }, backupJobVolumes: { columns: { volumeId: true } } },
      },
    },
  });
  return links
    .map((l) => l.backupJob)
    .filter((j) => j.organizationId === organizationId || j.organizationId === null)
    .map((j) => ({
      id: j.id,
      enabled: j.enabled,
      organizationId: j.organizationId,
      appIds: j.backupJobApps.map((a) => a.appId),
      volumeCount: j.backupJobVolumes.length,
    }));
}

/** Jobs of the org that cover this app alone. The switch turns these on and off. */
function ownedBy(jobs: OwnJob[], appId: string, organizationId: string): OwnJob[] {
  return jobs.filter(
    (j) => j.organizationId === organizationId && j.volumeCount === 0 && j.appIds.length === 1 && j.appIds[0] === appId,
  );
}

async function setJobsEnabled(ids: string[], enabled: boolean): Promise<void> {
  if (ids.length === 0) return;
  await db.update(backupJobs).set({ enabled, updatedAt: new Date() }).where(inArray(backupJobs.id, ids));
}

export type AppBackupStatus = "covered" | "no-target" | "uncovered" | "off";

export type AppBackupSwitchState = ResolvedBackupSwitch & {
  setting: boolean | null;
  orgSetting: boolean | null;
  systemDefault: boolean;
  status: AppBackupStatus;
};

/** The switch as the app's Backups tab shows it. */
export async function getAppBackupSwitchState(app: {
  id: string;
  organizationId: string;
  backupsEnabled: boolean | null;
  orgBackupsEnabled: boolean | null;
}): Promise<AppBackupSwitchState> {
  const systemDefault = await getSystemBackupsDefault();
  const resolved = resolveBackupSwitch(app.backupsEnabled, app.orgBackupsEnabled, systemDefault);
  let status: AppBackupStatus = "off";
  if (resolved.enabled) {
    const jobs = await jobsCovering(app.id, app.organizationId);
    if (jobs.some((j) => j.enabled)) status = "covered";
    else status = (await resolveBackupTarget(app.organizationId)) ? "uncovered" : "no-target";
  }
  return {
    ...resolved,
    setting: app.backupsEnabled,
    orgSetting: app.orgBackupsEnabled,
    systemDefault,
    status,
  };
}

/** Bring one app's jobs in line with its switch. `reenable` turns back on jobs the switch disabled. */
export async function applyBackupSwitch(
  app: { id: string; name: string; organizationId: string },
  enabled: boolean,
  opts: { reenable?: boolean } = {},
): Promise<"enabled" | "disabled" | "enrolled" | "unchanged" | "no-target" | "nothing-to-back-up"> {
  const jobs = await jobsCovering(app.id, app.organizationId);
  const own = ownedBy(jobs, app.id, app.organizationId);

  if (!enabled) {
    const running = own.filter((j) => j.enabled).map((j) => j.id);
    await setJobsEnabled(running, false);
    return running.length > 0 ? "disabled" : "unchanged";
  }

  if (opts.reenable) {
    const stopped = own.filter((j) => !j.enabled).map((j) => j.id);
    await setJobsEnabled(stopped, true);
    if (stopped.length > 0) return "enabled";
  }
  if (jobs.length > 0) return "unchanged";

  const { enrollNewApp } = await import("./enroll");
  const result = await enrollNewApp({ appId: app.id, appName: app.name, organizationId: app.organizationId, measure: true });
  if (result.status === "covered") return "enrolled";
  if (result.status === "no-target" || result.status === "nothing-to-back-up") return result.status;
  return "unchanged";
}

export type ReconcileScope = {
  organizationId?: string;
  /** Only apps without a setting of their own. */
  inheritOnly?: boolean;
  /** Only apps of orgs without a setting of their own. */
  orgInheritOnly?: boolean;
  reenable?: boolean;
};

let chain: Promise<unknown> = Promise.resolve();

/** Apply the switch to every app in scope. Runs one at a time. */
export function reconcileBackupSwitch(scope: ReconcileScope = {}): Promise<Record<string, number>> {
  const run = chain.then(() => reconcileNow(scope));
  chain = run.catch(() => {});
  return run;
}

async function reconcileNow(scope: ReconcileScope): Promise<Record<string, number>> {
  const { isFeatureEnabledAsync } = await import("@/lib/config/features");
  if (!(await isFeatureEnabledAsync("backups"))) return {};

  const systemDefault = await getSystemBackupsDefault();
  const conditions = [isNull(apps.parentAppId)];
  if (scope.organizationId) conditions.push(eq(apps.organizationId, scope.organizationId));
  if (scope.inheritOnly) conditions.push(isNull(apps.backupsEnabled));

  const rows = await db
    .select({
      id: apps.id,
      name: apps.name,
      organizationId: apps.organizationId,
      isSystemManaged: apps.isSystemManaged,
      backupsEnabled: apps.backupsEnabled,
      orgBackupsEnabled: organizations.backupsEnabled,
    })
    .from(apps)
    .innerJoin(organizations, eq(organizations.id, apps.organizationId))
    .where(and(...conditions));

  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (isVardoManagedApp(row)) continue;
    if (scope.orgInheritOnly && row.orgBackupsEnabled != null) continue;
    const { enabled } = resolveBackupSwitch(row.backupsEnabled, row.orgBackupsEnabled, systemDefault);
    try {
      const outcome = await applyBackupSwitch(row, enabled, { reenable: scope.reenable });
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    } catch (err) {
      counts.failed = (counts.failed ?? 0) + 1;
      log.warn(`Backup switch for ${row.name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (counts.enrolled || counts.disabled || counts.enabled) {
    log.info(
      `Backup switch: ${counts.enrolled ?? 0} enrolled, ${counts.enabled ?? 0} resumed, ${counts.disabled ?? 0} stopped`,
    );
  }
  return counts;
}

/** reconcileBackupSwitch for request paths: runs in the background, never throws. */
export function reconcileInBackground(scope: ReconcileScope): void {
  reconcileBackupSwitch(scope).catch((err) =>
    log.warn(`Backup switch reconcile failed: ${err instanceof Error ? err.message : err}`),
  );
}
