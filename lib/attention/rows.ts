import "server-only";

import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/lib/db";
import {
  apps,
  backupJobApps,
  backupJobs,
  backupJobVolumes,
  backups,
  deployments,
  notificationSends,
  projects,
  volumes,
} from "@/lib/db/schema";
import { resolveBackupTarget } from "@/lib/backups/auto-backup";
import { isBackupSelected } from "@/lib/backups/durability";
import { listUncoveredApps } from "@/lib/backups/enroll";
import { OVERDUE_INTERVALS, overdueBackupJobs } from "@/lib/backups/staleness";
import { defaultMemoryLimitMb, type QosTier } from "@/lib/docker/compose-inject";
import { getCooldownUntil } from "@/lib/docker/image-updates/check";
import { getAggregateUpdateStatus } from "@/lib/docker/image-updates/status";
import { calmQuietSubjects, conditionRows, hadRecentHostOom, oomRows, type AttentionRow } from "@/lib/ui/attention";
import { projectHref } from "@/lib/ui/hrefs";
import { isQuiet } from "@/lib/ui/urgency";
import { ANOMALY_ALERT_TYPES } from "@/lib/anomaly/pass";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { BACKUP_TITLE } from "@/lib/ui/conditions";
import { isVardoManagedApp } from "@/lib/infra/instance-apps";
import { getBuildSha, getChannelUpdate } from "@/lib/version";
import { isSelfDeployLayout } from "@/lib/paths";
import { formatVersion } from "@/lib/lifecycle/self-deploy";
import { effectiveChannel } from "@/lib/self-update/policy";
import { getUpdatePolicy, getUpdateRun } from "@/lib/self-update/store";
import { isRunActive } from "@/lib/self-update/decide";
import pkg from "@/package.json";
import { vardoUpdateRow } from "./vardo-update-row";
import { getElevatedApps } from "@/lib/logging/error-rate";
import { activityRows, getFleetActivity } from "./activity";
import {
  APP_DOWN_WINDOW_HOURS,
  appStatusRows,
  appStoppedRows,
  withParentNames,
} from "./app-status-rows";
import { backupCoverageRows, type SystemJobState } from "./backup-coverage-rows";
import { standingBackupFailures } from "./backup-failures";
import { errorRateRows } from "./error-rate-rows";
import { getFleetAttention } from "./fleet";
import { anomalyRows, deployFailureRows, DEPLOY_FAILURE_WINDOW_HOURS } from "./urgent-rows";

/** A failure older than this is history, not something to act on now. */
const BACKUP_FAILURE_WINDOW_HOURS = 48;

/** A compose child's parent, so a paused database says whose it is. */
const pausedParents = alias(apps, "paused_parents");

/** An OOM kill older than this is history too, even if the app is still down. */
const OOM_WINDOW_HOURS = 7 * 24;

/** How long a host kill keeps the unlimited-containers row above neutral. */
const HOST_OOM_PROMOTE_HOURS = 24;

function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

/** The Vardo update row on the policy's channel. Off shows nothing. */
async function loadVardoUpdateRow(): Promise<AttentionRow | null> {
  const policy = await getUpdatePolicy();
  if (policy.mode === "off") return null;
  const [update, run] = await Promise.all([getChannelUpdate(effectiveChannel(policy)), getUpdateRun()]);
  return vardoUpdateRow({
    update,
    currentVersion: formatVersion(pkg.version, getBuildSha()) ?? pkg.version,
    selfDeploy: isSelfDeployLayout(),
    runActive: isRunActive(run),
  });
}

/** Each app's most recent failure that no later run has cleared. */
async function loadFailedBackups(appIds: string[]) {
  if (appIds.length === 0) return [];
  const since = new Date(Date.now() - BACKUP_FAILURE_WINDOW_HOURS * 3_600_000);
  const rows = await db
    .select({
      id: backups.id,
      appId: backups.appId,
      jobId: backups.jobId,
      volumeName: backups.volumeName,
      status: backups.status,
      startedAt: backups.startedAt,
      log: backups.log,
    })
    .from(backups)
    .where(and(gte(backups.startedAt, since), inArray(backups.appId, appIds)));
  return standingBackupFailures(rows);
}

/** Jobs that have captured nothing for several schedule intervals, read from the jobs, not the apps. */
async function loadOverdueBackupJobs(orgId: string, now: Date) {
  const jobRows = await db
    .select({
      id: backupJobs.id,
      name: backupJobs.name,
      schedule: backupJobs.schedule,
      enabled: backupJobs.enabled,
      lastRunAt: backupJobs.lastRunAt,
      createdAt: backupJobs.createdAt,
    })
    .from(backupJobs)
    .where(eq(backupJobs.organizationId, orgId));

  const overdue = overdueBackupJobs(jobRows, now);
  if (overdue.length === 0) return [];

  const links = await db
    .select({ jobId: backupJobApps.backupJobId, id: apps.id, name: apps.name, displayName: apps.displayName })
    .from(backupJobApps)
    .innerJoin(apps, eq(apps.id, backupJobApps.appId))
    .where(
      inArray(
        backupJobApps.backupJobId,
        overdue.map((o) => o.job.id),
      ),
    );

  const appsByJob = new Map<string, { id: string; name: string; displayName: string }[]>();
  for (const { jobId, ...app } of links) {
    appsByJob.set(jobId, [...(appsByJob.get(jobId) ?? []), app]);
  }

  return overdue.map((entry) => ({ ...entry, apps: appsByJob.get(entry.job.id) ?? [] }));
}

const COVERAGE_TTL_MS = 30_000;
const coverageCache = new Map<string, { at: number; value: Promise<CoverageInput> }>();

type CoverageInput = Parameters<typeof backupCoverageRows>[0];

/** Whether anything backs up this org's data and, for admins, Vardo's own database. Cached briefly; the bar polls. */
function loadBackupCoverage(orgId: string, isAppAdmin: boolean): Promise<CoverageInput> {
  const key = `${orgId}:${isAppAdmin}`;
  const hit = coverageCache.get(key);
  if (hit && Date.now() - hit.at < COVERAGE_TTL_MS) return hit.value;

  const value = (async (): Promise<CoverageInput> => {
    const [target, uncovered, systemJob] = await Promise.all([
      resolveBackupTarget(orgId),
      listUncoveredApps(orgId, { measure: false }),
      isAppAdmin ? loadSystemJobState() : null,
    ]);
    return {
      hasTarget: !!target,
      uncovered: uncovered.map((a) => ({
        id: a.id,
        name: a.name,
        displayName: a.displayName,
        status: a.status,
        volumeCount: a.volumes.filter((v) => v.verdict !== "exclude").length,
      })),
      systemJob,
    };
  })();
  coverageCache.set(key, { at: Date.now(), value });
  value.catch(() => coverageCache.delete(key));
  return value;
}

/** The job that dumps Vardo's own database. */
async function loadSystemJobState(): Promise<SystemJobState> {
  const [row] = await db
    .select({
      id: backupJobs.id,
      name: backupJobs.name,
      schedule: backupJobs.schedule,
      enabled: backupJobs.enabled,
      lastRunAt: backupJobs.lastRunAt,
      createdAt: backupJobs.createdAt,
    })
    .from(volumes)
    .innerJoin(backupJobVolumes, eq(backupJobVolumes.volumeId, volumes.id))
    .innerJoin(backupJobs, eq(backupJobs.id, backupJobVolumes.backupJobId))
    .where(and(isNull(volumes.appId), eq(volumes.name, "postgres")))
    .limit(1);

  if (!row) return { kind: "missing" };
  if (!row.enabled) return { kind: "disabled" };
  const [overdue] = overdueBackupJobs([row], new Date());
  return overdue ? { kind: "overdue", since: overdue.since, neverRan: overdue.neverRan } : { kind: "ok" };
}

/** Stopped apps whose database can't be dumped until they run again. */
async function loadPausedDumps(orgId: string) {
  const rows = await db
    .select({
      id: apps.id,
      name: apps.name,
      displayName: apps.displayName,
      parentName: pausedParents.displayName,
      statusChangedAt: apps.statusChangedAt,
      isSystemManaged: apps.isSystemManaged,
      persistent: volumes.persistent,
      durability: volumes.durability,
    })
    .from(apps)
    .leftJoin(pausedParents, eq(pausedParents.id, apps.parentAppId))
    .innerJoin(volumes, eq(volumes.appId, apps.id))
    .innerJoin(backupJobApps, eq(backupJobApps.appId, apps.id))
    .innerJoin(
      backupJobs,
      and(eq(backupJobs.id, backupJobApps.backupJobId), eq(backupJobs.enabled, true)),
    )
    .where(
      and(
        eq(apps.organizationId, orgId),
        eq(apps.status, "stopped"),
        eq(volumes.backupStrategy, "dump"),
        isNull(volumes.removedAt),
      ),
    );

  const byApp = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (isVardoManagedApp(row)) continue;
    if (!isBackupSelected(row)) continue;
    if (!byApp.has(row.id)) byApp.set(row.id, row);
  }
  return [...byApp.values()];
}

/** Every app the kernel may have killed, children included. */
async function loadExitReasons(orgId: string) {
  const rows = await db
    .select({
      id: apps.id,
      name: apps.name,
      displayName: apps.displayName,
      exitReason: apps.exitReason,
      isSystemManaged: apps.isSystemManaged,
    })
    .from(apps)
    .where(and(eq(apps.organizationId, orgId), isNotNull(apps.exitReason)));
  return rows.filter((a) => !isVardoManagedApp(a));
}

/** Every app, children included. A child holds its own status and conditions. */
async function loadStatusSubjects(orgId: string) {
  const rows = await db
    .select({
      id: apps.id,
      name: apps.name,
      displayName: apps.displayName,
      status: apps.status,
      statusChangedAt: apps.statusChangedAt,
      parked: apps.parked,
      parentAppId: apps.parentAppId,
      conditions: apps.conditions,
      isSystemManaged: apps.isSystemManaged,
      projectName: projects.displayName,
      projectSlug: projects.name,
    })
    .from(apps)
    .leftJoin(projects, eq(projects.id, apps.projectId))
    .where(eq(apps.organizationId, orgId));
  return rows.filter((a) => !isVardoManagedApp(a));
}

/** Each app's latest deploy, when it started inside the window. A newer deploy would be inside it too. */
async function loadLatestDeploys(appIds: string[], now: number) {
  if (appIds.length === 0) return [];
  const since = new Date(now - DEPLOY_FAILURE_WINDOW_HOURS * 3_600_000);
  const rows = await db
    .select({
      id: deployments.id,
      appId: deployments.appId,
      status: deployments.status,
      gitSha: deployments.gitSha,
      startedAt: deployments.startedAt,
      finishedAt: deployments.finishedAt,
    })
    .from(deployments)
    .where(and(inArray(deployments.appId, appIds), gte(deployments.startedAt, since)))
    .orderBy(desc(deployments.startedAt));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.appId)) latest.set(row.appId, row);
  return [...latest.values()];
}

/** Anomaly alerts that fired and haven't cleared. */
async function loadOpenAnomalies(orgId: string) {
  const rows = await db
    .select({ about: notificationSends.about, sentAt: notificationSends.sentAt, detail: notificationSends.detail })
    .from(notificationSends)
    .where(
      and(
        eq(notificationSends.organizationId, orgId),
        inArray(notificationSends.type, ANOMALY_ALERT_TYPES),
        isNull(notificationSends.clearedAt),
      ),
    );
  return rows.map((r) => {
    const detail = (r.detail ?? {}) as { appId?: string; title?: string };
    return { about: r.about, appId: detail.appId ?? null, title: detail.title ?? "Unusual activity", sentAt: r.sentAt };
  });
}

type BuildOptions = {
  /** Admin only. */
  isAppAdmin: boolean;
};

/** Every notice the instance has, in one list. */
export async function buildAttentionRows(
  orgId: string,
  { isAppAdmin }: BuildOptions,
): Promise<AttentionRow[]> {
  // Parents own the compose; including children would double-count updates.
  const orgApps = await db
    .select({
      id: apps.id,
      name: apps.name,
      displayName: apps.displayName,
      status: apps.status,
      conditions: apps.conditions,
      containerMemoryLimit: apps.containerMemoryLimit,
      priority: apps.priority,
      deployType: apps.deployType,
      imageName: apps.imageName,
      composeContent: apps.composeContent,
      composeService: apps.composeService,
      isSystemManaged: apps.isSystemManaged,
    })
    .from(apps)
    .where(and(eq(apps.organizationId, orgId), isNull(apps.parentAppId)));

  // Vardo's stack and core services report at instance level; listing them here would duplicate rows.
  const appRows = orgApps.filter((a) => !isVardoManagedApp(a));

  const [imageUpdatesEnabled, backupsEnabled] = await Promise.all([
    isFeatureEnabledAsync("image-updates"),
    isFeatureEnabledAsync("backups"),
  ]);

  const appIds = appRows.map((a) => a.id);

  const [
    fleet,
    updates,
    version,
    failedBackups,
    overdueJobs,
    pausedDumps,
    activity,
    exited,
    subjects,
    elevated,
    coverage,
    latestDeploys,
    anomalies,
  ] = await Promise.all([
    getFleetAttention(orgId),
    getCooldownUntil().then((cooldown) => getAggregateUpdateStatus(orgId, appRows, cooldown)),
    isAppAdmin ? loadVardoUpdateRow().catch(() => null) : null,
    loadFailedBackups(appIds),
    loadOverdueBackupJobs(orgId, new Date()),
    loadPausedDumps(orgId),
    getFleetActivity(appIds),
    loadExitReasons(orgId),
    loadStatusSubjects(orgId),
    getElevatedApps(),
    backupsEnabled ? loadBackupCoverage(orgId, isAppAdmin) : null,
    loadLatestDeploys(appIds, Date.now()),
    loadOpenAnomalies(orgId),
  ]);

  const rows = conditionRows(withParentNames(subjects));
  rows.push(...deployFailureRows(subjects, latestDeploys, Date.now()));
  rows.push(...anomalyRows(subjects, anomalies));
  rows.push(...oomRows(exited, Date.now(), OOM_WINDOW_HOURS * 3_600_000));
  rows.push(...appStatusRows(subjects, Date.now(), APP_DOWN_WINDOW_HOURS * 3_600_000));
  rows.push(...appStoppedRows(subjects));
  rows.push(...errorRateRows(appRows, elevated));

  if (fleet.unreachableDomains.length > 0) {
    rows.push({
      key: "domain-unreachable",
      label: "Unreachable",
      tone: "error",
      group: "domains",
      items: fleet.unreachableDomains.map((d) => ({
        id: d.id,
        name: d.domain,
        href: d.appName ? `/apps/${d.appName}/networking` : "/settings/domains",
        detail: d.error ?? undefined,
      })),
      footer: "The last check for these domains failed.",
    });
  }

  // Informational, unless a recent host kill makes it a problem.
  const unlimited = appRows.filter(
    (a) => a.status === "active" && a.containerMemoryLimit === 0,
  );
  const hostOom = hadRecentHostOom(exited, Date.now(), HOST_OOM_PROMOTE_HOURS * 3_600_000);
  if (unlimited.length > 0) {
    rows.push({
      key: "no-memory-limit",
      label: "No memory limit",
      tone: hostOom ? "warning" : "neutral",
      ...(hostOom ? { group: "memory" as const } : {}),
      items: unlimited
        .map((a) => {
          const tier = (a.priority ?? "standard") as QosTier;
          return {
            id: a.id,
            name: a.displayName,
            href: `/apps/${a.name}`,
            detail: `${tier} · would cap at ${formatMb(defaultMemoryLimitMb(tier))}`,
          };
        }),
      footer: hostOom
        ? "The host ran out of memory recently and the kernel chose from this list. Redeploying applies the tier cap shown. Set an explicit limit first on anything that needs more than its cap."
        : "Redeploying applies the tier cap shown. Set an explicit limit first on anything that needs more than its cap.",
    });
  }

  if (imageUpdatesEnabled && updates.appsWithUpdates.length > 0) {
    const notes = ["Review the proposed version before applying it."];
    if (updates.unknownCount > 0) {
      notes.push(
        `${updates.unknownCount} image${updates.unknownCount === 1 ? "" : "s"} could not be checked.`,
      );
    }
    if (updates.cooldownUntil) {
      notes.push(
        `Checks are paused until ${new Date(updates.cooldownUntil).toLocaleTimeString()} after a registry rate limit.`,
      );
    }
    rows.push({
      key: "image-updates",
      label: "Image updates",
      tone: "neutral",
      items: updates.appsWithUpdates.map((a) => ({
        id: a.id,
        name: a.displayName,
        href: `/apps/${a.name}/updates`,
        detail: `${a.count} image${a.count === 1 ? "" : "s"}`,
      })),
      footer: notes.join(" "),
      action: { label: "Review all updates", href: "/updates" },
    });
  }

  const backUp = (app: { id: string; name: string }) =>
    ({ label: "Back up now", run: "backup", app: { id: app.id, name: app.name } }) as const;

  if (failedBackups.length > 0) {
    const byApp = new Map(appRows.map((a) => [a.id, a]));
    rows.push({
      key: "backup-failed",
      label: BACKUP_TITLE.failed,
      tone: "error",
      group: "backups",
      items: failedBackups.flatMap((b) => {
        const app = b.appId ? byApp.get(b.appId) : undefined;
        if (!app) return [];
        return [
          {
            id: b.id,
            subject: app.id,
            name: app.displayName,
            href: `/apps/${app.name}/backups`,
            detail: b.volumeName ? `Volume ${b.volumeName}` : undefined,
            since: b.startedAt.toISOString(),
            fix: backUp(app),
          },
        ];
      }),
      footer: `Apps whose latest backup in the last ${BACKUP_FAILURE_WINDOW_HOURS} hours failed.`,
    });
  }

  if (overdueJobs.length > 0) {
    rows.push({
      key: "backup-overdue",
      label: BACKUP_TITLE.overdue,
      tone: "warning",
      group: "backups",
      items: overdueJobs.flatMap((o) => {
        const title = o.neverRan ? BACKUP_TITLE.never : BACKUP_TITLE.overdue;
        const since = o.since.toISOString();
        // The job's apps are the subjects, so each counts once.
        if (o.apps.length === 0) {
          return [{ id: o.job.id, name: o.job.name, title, href: "/backups", detail: "Backup job", since }];
        }
        return o.apps.map((app) => ({
          id: `${o.job.id}:${app.id}`,
          subject: app.id,
          name: app.displayName,
          title,
          href: `/apps/${app.name}/backups`,
          detail: `Job ${o.job.name}`,
          since,
          fix: backUp(app),
        }));
      }),
      footer: `Each of these jobs has captured nothing for more than ${OVERDUE_INTERVALS} runs of its own schedule.`,
    });
  }

  if (coverage) rows.push(...backupCoverageRows(coverage));

  if (pausedDumps.length > 0) {
    rows.push({
      key: "backup-paused",
      label: BACKUP_TITLE.paused,
      tone: "warning",
      group: "backups",
      items: pausedDumps.map((a) => ({
        id: a.id,
        name: a.parentName ? `${a.parentName} · ${a.displayName}` : a.displayName,
        href: `/apps/${a.name}/backups`,
        detail: "Database dump needs a running container",
        since: a.statusChangedAt?.toISOString(),
        fix: { label: "Start", run: "restart", app: { id: a.id, name: a.name } },
      })),
      footer:
        "These apps are stopped. Their volumes are still archived on schedule, but a database dump cannot run until the app is started.",
    });
  }

  rows.push(...activityRows(appRows, activity));

  if (version) rows.push(version);

  const quiet = new Set(subjects.filter(isQuiet).map((s) => s.id));
  return calmQuietSubjects(withWhere(rows, subjects), quiet);
}

/** Names each app item's project, and parent when nested. */
function withWhere(
  rows: AttentionRow[],
  subjects: {
    id: string;
    parentAppId: string | null;
    displayName: string;
    projectName: string | null;
    projectSlug: string | null;
  }[],
): AttentionRow[] {
  const byId = new Map(subjects.map((s) => [s.id, s]));
  const project = (id: string) => byId.get(id)?.projectSlug ?? undefined;
  const where = (id: string) => {
    const app = byId.get(id);
    if (!app) return undefined;
    const parent = app.parentAppId ? byId.get(app.parentAppId)?.displayName : undefined;
    return [app.projectName, parent].filter(Boolean).join(" / ") || undefined;
  };
  return rows.map((row) => ({
    ...row,
    items: row.items.map((item) => {
      const slug = project(item.subject ?? item.id);
      return {
        ...item,
        where: item.where ?? where(item.subject ?? item.id),
        whereHref: item.whereHref ?? (slug ? projectHref(slug) : undefined),
      };
    }),
  }));
}
