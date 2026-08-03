import "server-only";

import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps, backups } from "@/lib/db/schema";
import { defaultMemoryLimitMb, type QosTier } from "@/lib/docker/compose-inject";
import { getCooldownUntil } from "@/lib/docker/image-updates/check";
import { getAggregateUpdateStatus } from "@/lib/docker/image-updates/status";
import { conditionRows, hadRecentHostOom, oomRows, type AttentionRow } from "@/lib/ui/attention";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { isVardoManagedApp } from "@/lib/infra/instance-apps";
import { getVersionData } from "@/lib/version";
import { getElevatedApps } from "@/lib/logging/error-rate";
import { activityRows, getFleetActivity } from "./activity";
import {
  APP_DOWN_WINDOW_HOURS,
  appStatusRows,
  appStoppedRows,
  withParentNames,
} from "./app-status-rows";
import { errorRateRows } from "./error-rate-rows";
import { getFleetAttention } from "./fleet";

/** A failure older than this is history, not something to act on now. */
const BACKUP_FAILURE_WINDOW_HOURS = 48;

/** An OOM kill older than this is history too, even if the app is still down. */
const OOM_WINDOW_HOURS = 7 * 24;

/** How long a host kill keeps the unlimited-containers row above neutral. */
const HOST_OOM_PROMOTE_HOURS = 24;

function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

/** Most recent failure per app, so one broken job is one row rather than seven. */
async function loadFailedBackups(appIds: string[]) {
  if (appIds.length === 0) return [];
  const since = new Date(Date.now() - BACKUP_FAILURE_WINDOW_HOURS * 3_600_000);
  const rows = await db
    .select({ id: backups.id, appId: backups.appId, startedAt: backups.startedAt })
    .from(backups)
    .where(
      and(
        eq(backups.status, "failed"),
        gte(backups.startedAt, since),
        inArray(backups.appId, appIds),
      ),
    )
    .orderBy(desc(backups.startedAt));

  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.appId && !latest.has(row.appId)) latest.set(row.appId, row);
  }
  return [...latest.values()];
}

/**
 * Every app the kernel may have killed, children included — a compose service
 * that OOMs is the subject, not the parent that is otherwise fine.
 */
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

/**
 * Every app, children included. A compose child holds its own status and
 * conditions — a stack whose database is down still reads active on the parent.
 */
async function loadStatusSubjects(orgId: string) {
  const rows = await db
    .select({
      id: apps.id,
      name: apps.name,
      displayName: apps.displayName,
      status: apps.status,
      statusChangedAt: apps.statusChangedAt,
      parentAppId: apps.parentAppId,
      conditions: apps.conditions,
      isSystemManaged: apps.isSystemManaged,
    })
    .from(apps)
    .where(eq(apps.organizationId, orgId));
  return rows.filter((a) => !isVardoManagedApp(a));
}

type BuildOptions = {
  /** Release availability is admin business — non-admins never see the row. */
  isAppAdmin: boolean;
};

/**
 * Every notice the instance has, in one list. The chrome renders this on every
 * page, so it is built here rather than assembled per route.
 */
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

  // Vardo's own stack and the core services report at instance level, to every
  // session. Leaving them here too would give the Vardo org two rows per event.
  const appRows = orgApps.filter((a) => !isVardoManagedApp(a));

  const imageUpdatesEnabled = await isFeatureEnabledAsync("image-updates");

  const appIds = appRows.map((a) => a.id);

  const [fleet, updates, version, failedBackups, activity, exited, subjects, elevated] = await Promise.all([
    getFleetAttention(orgId),
    getCooldownUntil().then((cooldown) => getAggregateUpdateStatus(orgId, appRows, cooldown)),
    isAppAdmin ? getVersionData().catch(() => null) : null,
    loadFailedBackups(appIds),
    getFleetActivity(appIds),
    loadExitReasons(orgId),
    loadStatusSubjects(orgId),
    getElevatedApps(),
  ]);

  const rows = conditionRows(withParentNames(subjects));
  rows.push(...appStatusRows(subjects, Date.now(), APP_DOWN_WINDOW_HOURS * 3_600_000));
  rows.push(...appStoppedRows(subjects));
  rows.push(...oomRows(exited, Date.now(), OOM_WINDOW_HOURS * 3_600_000));
  rows.push(...errorRateRows(appRows, elevated));

  if (fleet.unreachableDomains.length > 0) {
    rows.push({
      key: "domain-unreachable",
      label: "Domain unreachable",
      tone: "error",
      items: fleet.unreachableDomains.map((d) => ({
        id: d.id,
        name: d.domain,
        href: d.appName ? `/apps/${d.appName}/networking` : "/settings/domains",
        detail: d.error ?? undefined,
      })),
      footer: "The last check for these domains failed.",
    });
  }

  // Containers running with no cgroup memory limit can take the whole host, and
  // a JVM in one sizes its heap from the hypervisor's RAM, not the guest's.
  //
  // Neutral, not a fault: every app deployed before limits were injected lands
  // here, so counting them buries the handful of things actually broken. A
  // recent host kill promotes it — the kernel picks its victim from this pool.
  const unlimited = appRows.filter(
    (a) => a.status === "active" && a.containerMemoryLimit === 0,
  );
  const hostOom = hadRecentHostOom(exited, Date.now(), HOST_OOM_PROMOTE_HOURS * 3_600_000);
  if (unlimited.length > 0) {
    rows.push({
      key: "no-memory-limit",
      label: "No memory limit",
      tone: hostOom ? "warning" : "neutral",
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

  if (failedBackups.length > 0) {
    const byApp = new Map(appRows.map((a) => [a.id, a]));
    rows.push({
      key: "backup-failed",
      label: "Backup failed",
      tone: "error",
      items: failedBackups.map((b) => {
        const app = b.appId ? byApp.get(b.appId) : undefined;
        return {
          id: b.id,
          name: app?.displayName ?? "Unknown app",
          href: app ? `/apps/${app.name}/backups` : "/backups",
          since: b.startedAt.toISOString(),
        };
      }),
      footer: `${failedBackups.length} app${failedBackups.length === 1 ? "" : "s"} failed a backup in the last ${BACKUP_FAILURE_WINDOW_HOURS} hours. Each row is its most recent failure.`,
    });
  }

  rows.push(...activityRows(appRows, activity));

  if (version?.hasUpdate) {
    rows.push({
      key: "vardo-update",
      label: "Vardo update",
      tone: "neutral",
      items: [
        {
          id: version.latestVersion,
          name: `Vardo ${version.latestVersion}`,
          href: version.releaseUrl,
          detail: `You are on ${version.currentVersion}`,
          external: true,
        },
      ],
      footer: "Release notes open on GitHub.",
    });
  }

  return rows;
}
