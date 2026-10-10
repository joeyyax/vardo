// What happened in one org over a digest window. A record of the window, not live state, except certs and updates.

import { and, count, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { alertHistory, apps, backups, cronJobRuns, cronJobs, deployments, domainCertChecks, domains } from "@/lib/db/schema";
import type { DigestHealthEvent, DigestProjectRow } from "@/lib/bus/events";
import { ALERTS, isAlertType } from "@/lib/notifications/registry";
import { CERT_EXPIRY_THRESHOLD_DAYS } from "@/lib/system-alerts/cert-expiry";
import { bucketMsFor, bucketStarts, type DigestWindow } from "./window";

export type DigestData = Omit<DigestHealthEvent, "type" | "title" | "message">;

const DAY_MS = 86_400_000;
const TOP_ALERTS = 5;

/** Deploys per bucket across the window, oldest first. */
export function deployBuckets(
  rows: { status: string; startedAt: Date }[],
  window: Pick<DigestWindow, "since" | "until">,
  bucketMs: number,
): NonNullable<DigestHealthEvent["deploysByBucket"]> {
  const starts = bucketStarts(window, bucketMs);
  const buckets = starts.map((start) => ({ start: new Date(start).toISOString(), succeeded: 0, failed: 0 }));
  for (const row of rows) {
    const i = Math.floor((row.startedAt.getTime() - window.since.getTime()) / bucketMs);
    if (i < 0 || i >= buckets.length) continue;
    if (row.status === "failed") buckets[i].failed += 1;
    else if (row.status === "success") buckets[i].succeeded += 1;
  }
  return buckets;
}

export function windowLabel(window: Pick<DigestWindow, "since" | "until">): string {
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const last = new Date(window.until.getTime() - DAY_MS);
  const year = last.getUTCFullYear();
  return last.getTime() <= window.since.getTime() ? `${fmt(window.since)}, ${year}` : `${fmt(window.since)} – ${fmt(last)}, ${year}`;
}

/** Whether anything happened in the window. An empty window sends nothing. */
export function hasActivity(data: Pick<DigestData, "deploys" | "backups" | "cron" | "alerts">): boolean {
  return (
    data.deploys.total > 0 ||
    data.backups.succeeded + data.backups.failed + data.backups.drillsPassed + data.backups.drillsFailed > 0 ||
    data.cron.failed > 0 ||
    data.alerts.fired + data.alerts.resolved + data.alerts.open > 0
  );
}

/** Top alert types fired in the window, by count. */
export function topAlerts(rows: { type: string }[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = isAlertType(row.type) ? ALERTS[row.type].label : row.type;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => ({ label, count: n })).sort((a, b) => b.count - a.count).slice(0, TOP_ALERTS);
}

async function hostTrends(window: DigestWindow): Promise<DigestHealthEvent["resources"]> {
  const { queryHostHistory } = await import("@/lib/metrics/store-host");
  const bucketMs = window.cadence === "daily" ? 60 * 60_000 : 6 * 60 * 60_000;
  const from = window.since.getTime();
  const to = window.until.getTime() - 1;
  const series = [
    { metric: "cpu" as const, label: "CPU", unit: "percent" as const },
    { metric: "memory" as const, label: "Memory", unit: "percent" as const },
    { metric: "disk" as const, label: "Disk", unit: "percent" as const },
    { metric: "load" as const, label: "Load", unit: "per-core" as const },
  ];
  const out = await Promise.all(
    series.map(async ({ metric, label, unit }) => {
      const values = (await queryHostHistory(metric, from, to, bucketMs)).map(([, v]) => v);
      if (values.length < 2) return null;
      return { label, values, latest: values.at(-1)!, peak: Math.max(...values), unit };
    }),
  );
  const trends = out.filter((t) => t !== null);
  return trends.length ? trends : undefined;
}

async function expiringCerts(orgId: string, now: Date): Promise<DigestHealthEvent["certs"]> {
  const rows = await db
    .select({ domain: domains.domain, expiresAt: domainCertChecks.expiresAt })
    .from(domainCertChecks)
    .innerJoin(domains, eq(domains.id, domainCertChecks.domainId))
    .innerJoin(apps, eq(apps.id, domains.appId))
    .where(and(eq(apps.organizationId, orgId), lt(domainCertChecks.expiresAt, new Date(now.getTime() + CERT_EXPIRY_THRESHOLD_DAYS * DAY_MS))));
  return rows
    .flatMap((r) => (r.expiresAt ? [{ domain: r.domain, daysLeft: Math.floor((r.expiresAt.getTime() - now.getTime()) / DAY_MS) }] : []))
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

async function imageUpdates(orgId: string): Promise<DigestHealthEvent["imageUpdates"]> {
  const { isFeatureEnabledAsync } = await import("@/lib/config/features");
  if (!(await isFeatureEnabledAsync("image-updates"))) return [];
  const { getAggregateUpdateStatus } = await import("@/lib/docker/image-updates/status");
  const { getCooldownUntil } = await import("@/lib/docker/image-updates/check");
  const rows = await db
    .select({
      id: apps.id,
      name: apps.name,
      displayName: apps.displayName,
      deployType: apps.deployType,
      imageName: apps.imageName,
      composeContent: apps.composeContent,
      composeService: apps.composeService,
      isSystemManaged: apps.isSystemManaged,
    })
    .from(apps)
    .where(and(eq(apps.organizationId, orgId), isNull(apps.parentAppId)));
  const status = await getAggregateUpdateStatus(orgId, rows, await getCooldownUntil());
  return status.appsWithUpdates.map((a) => ({ appName: a.displayName || a.name, count: a.count }));
}

/** One org's digest for a window. `withHost` adds host trends, for orgs with an instance admin. */
export async function collectDigestData(
  orgId: string,
  orgName: string,
  window: DigestWindow,
  opts: { withHost?: boolean; now?: Date } = {},
): Promise<DigestData> {
  const now = opts.now ?? new Date();
  const inWindow = (column: AnyPgColumn) => and(gte(column, window.since), lt(column, window.until));

  const orgApps = await db.query.apps.findMany({
    where: eq(apps.organizationId, orgId),
    columns: { id: true, name: true, displayName: true, projectId: true },
  });
  const appIds = orgApps.map((a) => a.id);
  const orgCronJobs = await db.query.cronJobs.findMany({
    where: eq(cronJobs.organizationId, orgId),
    columns: { id: true, name: true, appId: true },
  });

  const [deployRows, backupRows, drillRows, cronRuns, fired, resolvedCount, openCount, stale, certs, updates, resources] = await Promise.all([
    appIds.length
      ? db
          .select({ appId: deployments.appId, status: deployments.status, startedAt: deployments.startedAt })
          .from(deployments)
          .where(and(inArray(deployments.appId, appIds), inWindow(deployments.startedAt)))
      : Promise.resolve([]),
    db
      .select({ appId: backups.appId, status: backups.status, size: backups.sizeBytes })
      .from(backups)
      .where(and(eq(backups.organizationId, orgId), inWindow(backups.startedAt))),
    db
      .select({ outcome: backups.verifyOutcome, n: count() })
      .from(backups)
      .where(and(eq(backups.organizationId, orgId), inWindow(backups.verifiedAt)))
      .groupBy(backups.verifyOutcome),
    orgCronJobs.length
      ? db.query.cronJobRuns.findMany({
          where: and(inArray(cronJobRuns.cronJobId, orgCronJobs.map((j) => j.id)), inWindow(cronJobRuns.startedAt), eq(cronJobRuns.status, "failed")),
          columns: { cronJobId: true },
        })
      : Promise.resolve([]),
    db.select({ type: alertHistory.type }).from(alertHistory).where(and(eq(alertHistory.organizationId, orgId), inWindow(alertHistory.firedAt))),
    db.select({ n: count() }).from(alertHistory).where(and(eq(alertHistory.organizationId, orgId), inWindow(alertHistory.resolvedAt))),
    db
      .select({ n: count() })
      .from(alertHistory)
      .where(and(eq(alertHistory.organizationId, orgId), isNull(alertHistory.resolvedAt), lt(alertHistory.firedAt, window.until))),
    import("@/lib/backups/runs").then(({ loadStaleVolumes }) => loadStaleVolumes(orgId, window.until.getTime())),
    expiringCerts(orgId, now),
    imageUpdates(orgId).catch(() => []),
    opts.withHost ? hostTrends(window).catch(() => undefined) : Promise.resolve(undefined),
  ]);

  const deploys = {
    total: deployRows.length,
    succeeded: deployRows.filter((d) => d.status === "success").length,
    failed: deployRows.filter((d) => d.status === "failed").length,
  };

  const jobById = new Map(orgCronJobs.map((j) => [j.id, j]));
  const appById = new Map(orgApps.map((a) => [a.id, a]));
  const projects = new Map<string, DigestProjectRow>();
  const project = (appId: string | null) => {
    const app = appId ? appById.get(appId) : undefined;
    if (!app) return null;
    const key = app.projectId ?? `app:${app.id}`;
    const row = projects.get(key) ?? { name: app.displayName || app.name, deploys: 0, failures: 0, backupFailures: 0, cronFailures: 0 };
    projects.set(key, row);
    return row;
  };
  for (const d of deployRows) {
    const row = project(d.appId);
    if (!row) continue;
    row.deploys += 1;
    if (d.status === "failed") row.failures += 1;
  }
  for (const b of backupRows) {
    const row = b.status === "failed" ? project(b.appId) : null;
    if (row) row.backupFailures += 1;
  }
  for (const run of cronRuns) {
    const row = project(jobById.get(run.cronJobId)?.appId ?? null);
    if (row) row.cronFailures += 1;
  }

  const drills = new Map(drillRows.map((r) => [r.outcome, r.n]));
  return {
    cadence: window.cadence,
    orgName,
    windowLabel: windowLabel(window),
    since: window.since.toISOString(),
    until: window.until.toISOString(),
    deploys,
    deploysByBucket: deployBuckets(deployRows, window, bucketMsFor(window.cadence)),
    backups: {
      succeeded: backupRows.filter((b) => b.status === "success").length,
      failed: backupRows.filter((b) => b.status === "failed").length,
      totalSize: backupRows.reduce((sum, b) => sum + (b.status === "success" ? b.size ?? 0 : 0), 0),
      drillsPassed: drills.get("verified") ?? 0,
      drillsFailed: drills.get("failed") ?? 0,
      staleVolumes: stale.length,
    },
    cron: {
      failed: cronRuns.length,
      affectedJobs: [...new Set(cronRuns.map((r) => jobById.get(r.cronJobId)?.name).filter((n): n is string => Boolean(n)))],
    },
    alerts: { fired: fired.length, resolved: resolvedCount[0]?.n ?? 0, open: openCount[0]?.n ?? 0, top: topAlerts(fired) },
    resources,
    certs,
    imageUpdates: updates,
    projects: [...projects.values()]
      .filter((p) => p.deploys + p.failures + p.backupFailures + p.cronFailures > 0)
      .sort((a, b) => b.failures + b.backupFailures + b.cronFailures - (a.failures + a.backupFailures + a.cronFailures) || b.deploys - a.deploys),
  };
}

/** The bus event for a digest. */
export function digestEvent(data: DigestData): DigestHealthEvent {
  const period = data.cadence === "daily" ? "Daily" : "Weekly";
  return {
    type: "digest.health",
    title: `${period} health summary: ${data.orgName}`,
    message: `${data.deploys.total} deploys, ${data.deploys.failed} failed; ${data.backups.failed} backup failures; ${data.alerts.fired} alerts.`,
    ...data,
  };
}
