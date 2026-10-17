// What happened in one org over a digest window. A record of the window, not live state, except certs and updates.

import { and, count, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { appNotRunning } from "@/lib/apps/run-state";
import { withJobApps } from "@/lib/backups/job-apps";
import { backupJobStaleness, type StoppedBackupJob } from "@/lib/backups/staleness";
import { activities, alertHistory, appRecaps, appSecurityScans, apps, backupJobs, backupRuns, backups, cronJobRuns, cronJobs, deployments, domainCertChecks, domains, projects } from "@/lib/db/schema";
import type { DigestHealthEvent, DigestProjectRow } from "@/lib/bus/events";
import { ALERTS, isAlertType } from "@/lib/notifications/registry";
import { CERT_EXPIRY_THRESHOLD_DAYS } from "@/lib/system-alerts/cert-expiry";
import { RECAP_AGE_MS } from "@/lib/recaps/schedule";
import { dayStarts, type DigestWindow } from "./window";
import { UTC, zonedDateKey, zonedParts } from "@/lib/time-zone";

export type DigestData = Omit<DigestHealthEvent, "type" | "title" | "message">;

const DAY_MS = 86_400_000;
const TOP_ALERTS = 5;

/** Deploys per local day across the window, oldest first. */
export function deployBuckets(
  rows: { status: string; startedAt: Date }[],
  window: Pick<DigestWindow, "since" | "until"> & { timeZone?: string },
): NonNullable<DigestHealthEvent["deploysByBucket"]> {
  const starts = dayStarts(window);
  const buckets = starts.map((start) => ({ start: new Date(start).toISOString(), succeeded: 0, failed: 0 }));
  for (const row of rows) {
    const t = row.startedAt.getTime();
    if (t >= window.until.getTime()) continue;
    const i = starts.findLastIndex((start) => start <= t);
    if (i < 0) continue;
    if (row.status === "failed") buckets[i].failed += 1;
    else if (row.status === "success") buckets[i].succeeded += 1;
  }
  return buckets;
}

export function windowLabel(window: Pick<DigestWindow, "since" | "until"> & { timeZone?: string; cadence?: DigestWindow["cadence"] }): string {
  const timeZone = window.timeZone ?? UTC;
  if (window.cadence === "monthly") return window.since.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone });
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  // An hour before the end is inside the last day even when DST made it 23 hours.
  const last = new Date(window.until.getTime() - 3_600_000);
  const year = zonedParts(last, timeZone).year;
  return zonedDateKey(last, timeZone) === zonedDateKey(window.since, timeZone) ? `${fmt(window.since)}, ${year}` : `${fmt(window.since)} – ${fmt(last)}, ${year}`;
}

/** Whether anything happened in the window. An empty window sends nothing. */
export function hasActivity(data: Pick<DigestData, "deploys" | "backups" | "cron" | "alerts"> & Pick<Partial<DigestData>, "scans">): boolean {
  return (
    data.deploys.total > 0 ||
    data.backups.succeeded + data.backups.failed + data.backups.drillsPassed + data.backups.drillsFailed > 0 ||
    data.cron.failed > 0 ||
    data.alerts.fired + data.alerts.resolved + data.alerts.open > 0 ||
    (data.scans?.scanned ?? 0) > 0
  );
}

type ScanRow = { appId: string; status: string; criticalCount: number; warningCount: number; startedAt: Date; completedAt: Date | null };

/** Scans in the window rolled up: how many, how many apps, and what each app's latest scan found. */
export function scanRollup(rows: ScanRow[]): NonNullable<DigestHealthEvent["scans"]> {
  const done = rows.filter((r) => r.status === "completed");
  const latest = new Map<string, ScanRow>();
  for (const row of done) {
    const seen = latest.get(row.appId);
    if (!seen || seen.startedAt < row.startedAt) latest.set(row.appId, row);
  }
  const last = done.reduce<Date | null>((max, r) => (r.completedAt && (!max || r.completedAt > max) ? r.completedAt : max), null);
  const current = [...latest.values()];
  return {
    scanned: done.length,
    apps: latest.size,
    lastRunAt: last?.toISOString() ?? null,
    appsWithFindings: current.filter((r) => r.criticalCount + r.warningCount > 0).length,
    critical: current.reduce((n, r) => n + r.criticalCount, 0),
    warnings: current.reduce((n, r) => n + r.warningCount, 0),
  };
}

type RunRow = { finishedAt: Date | null };

/** Backup runs that finished in the window: how many, when the last ended. */
export function backupRunRollup(rows: RunRow[]): { runs: number; lastRunAt: string | null } {
  const last = rows.reduce<Date | null>((max, r) => (r.finishedAt && (!max || r.finishedAt > max) ? r.finishedAt : max), null);
  return { runs: rows.length, lastRunAt: last?.toISOString() ?? null };
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

/** Stale volumes grouped by app, most first. */
export function staleByApp(rows: { appId: string | null; appName: string }[]): NonNullable<DigestHealthEvent["staleApps"]> {
  const byApp = new Map<string, { appId: string | null; appName: string; volumes: number }>();
  for (const r of rows) {
    const key = r.appId ?? `name:${r.appName}`;
    const entry = byApp.get(key) ?? { appId: r.appId, appName: r.appName, volumes: 0 };
    entry.volumes += 1;
    byApp.set(key, entry);
  }
  return [...byApp.values()].sort((a, b) => b.volumes - a.volumes);
}

/** Jobs past due only because their apps were stopped on purpose. Live at send time. */
async function loadStoppedBackupJobs(orgId: string, now: Date) {
  const jobs = await db.query.backupJobs.findMany({
    where: and(eq(backupJobs.organizationId, orgId), eq(backupJobs.enabled, true)),
    columns: { id: true, name: true, schedule: true, enabled: true, lastRunAt: true, createdAt: true },
  });
  return backupJobStaleness(await withJobApps(jobs, now), now).stopped;
}

/** Each stopped app once, with its newest last backup across its jobs. */
export function stoppedBackupApps(jobs: StoppedBackupJob[], nameOf: (appId: string) => string | null): NonNullable<DigestHealthEvent["stoppedBackups"]> {
  const byApp = new Map<string, { appId: string; appName: string; lastBackupAt: string | null }>();
  for (const { job, lastBackupAt } of jobs) {
    for (const app of job.apps ?? []) {
      const appName = nameOf(app.id);
      if (!appName) continue;
      const at = lastBackupAt?.toISOString() ?? null;
      const held = byApp.get(app.id);
      if (!held || (at && (!held.lastBackupAt || at > held.lastBackupAt))) byApp.set(app.id, { appId: app.id, appName, lastBackupAt: at });
    }
  }
  return [...byApp.values()].sort((a, b) => a.appName.localeCompare(b.appName));
}

/** How far back a start looks for the stop before it. */
export const LIFECYCLE_LOOKBACK_MS = 365 * DAY_MS;

type LifecycleRow = { appId: string; action: string; at: Date };

/** Each app's last start or stop in the window, oldest first. A start says how long the app was stopped before it. */
export function lifecycleChanges(rows: LifecycleRow[], window: Pick<DigestWindow, "since" | "until">): { appId: string; kind: "started" | "stopped"; at: string; stoppedMs: number | null }[] {
  const byApp = new Map<string, LifecycleRow[]>();
  for (const r of [...rows].sort((a, b) => a.at.getTime() - b.at.getTime())) byApp.set(r.appId, [...(byApp.get(r.appId) ?? []), r]);
  const out: { appId: string; kind: "started" | "stopped"; at: string; stoppedMs: number | null }[] = [];
  for (const [appId, list] of byApp) {
    const inside = list.filter((r) => r.at >= window.since && r.at < window.until);
    const last = inside.at(-1);
    if (!last) continue;
    if (last.action === "app.stopped") {
      out.push({ appId, kind: "stopped", at: last.at.toISOString(), stoppedMs: null });
      continue;
    }
    const before = list.slice(0, list.indexOf(last)).at(-1);
    out.push({ appId, kind: "started", at: last.at.toISOString(), stoppedMs: before?.action === "app.stopped" ? last.at.getTime() - before.at.getTime() : null });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

type SeenItem = { kind: "port" | "process"; item: string; state: string; first: number };

/** Items a deploy taught an app inside the window: learned ("known") then, and past the app's first three days. */
export function deployChanges(items: SeenItem[], window: Pick<DigestWindow, "since" | "until">, firstDeployAt: Date | null): SeenItem[] {
  const settled = firstDeployAt ? firstDeployAt.getTime() + RECAP_AGE_MS["72h"] : -Infinity;
  return items
    .filter((i) => i.state === "known" && i.first >= window.since.getTime() && i.first < window.until.getTime() && i.first >= settled)
    .sort((a, b) => a.first - b.first);
}

async function seenChanges(
  candidates: { id: string; name: string; firstDeployAt: Date | null }[],
  window: DigestWindow,
): Promise<NonNullable<DigestHealthEvent["changes"]>> {
  if (!candidates.length) return [];
  const { readSeen } = await import("@/lib/anomaly/store");
  const out: NonNullable<DigestHealthEvent["changes"]> = [];
  for (const app of candidates) {
    const [ports, procs] = await Promise.all([readSeen(app.id, "ports"), readSeen(app.id, "procs")]);
    const items: SeenItem[] = [
      ...[...ports].map(([item, e]) => ({ kind: "port" as const, item, state: e.state, first: e.first })),
      ...[...procs].map(([item, e]) => ({ kind: "process" as const, item, state: e.state, first: e.first })),
    ];
    for (const c of deployChanges(items, window, app.firstDeployAt)) {
      out.push({ appId: app.id, appName: app.name, kind: c.kind, item: c.item, since: new Date(c.first).toISOString() });
    }
  }
  return out;
}

async function hostTrends(window: DigestWindow): Promise<DigestHealthEvent["resources"]> {
  const { queryHostHistory } = await import("@/lib/metrics/store-host");
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
      const [peaks, recent] = await Promise.all([
        queryHostHistory(metric, from, to, DAY_MS, "max"),
        queryHostHistory(metric, Math.max(from, to - 6 * 3_600_000), to, 6 * 3_600_000),
      ]);
      const values = peaks.map(([, v]) => v);
      if (values.length < 2) return null;
      return { label, values, latest: recent.at(-1)?.[1] ?? values.at(-1)!, peak: Math.max(...values), unit };
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
    .where(and(eq(apps.organizationId, orgId), eq(domains.enabled, true), lt(domainCertChecks.expiresAt, new Date(now.getTime() + CERT_EXPIRY_THRESHOLD_DAYS * DAY_MS))));
  return rows
    .flatMap((r) => (r.expiresAt ? [{ domain: r.domain, daysLeft: Math.floor((r.expiresAt.getTime() - now.getTime()) / DAY_MS) }] : []))
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

type ImageUpdateFacts = Pick<DigestHealthEvent, "imageUpdates" | "majorNotices">;

const NO_IMAGE_UPDATES: ImageUpdateFacts = { imageUpdates: [], majorNotices: [] };

async function imageUpdates(orgId: string): Promise<ImageUpdateFacts> {
  const { isFeatureEnabledAsync } = await import("@/lib/config/features");
  if (!(await isFeatureEnabledAsync("image-updates"))) return NO_IMAGE_UPDATES;
  const { describeMajorNotice } = await import("@/lib/attention/major-notice-rows");
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
  return {
    imageUpdates: status.appsWithUpdates.map((a) => ({ appId: a.id, appName: a.displayName || a.name, count: a.count })).sort((a, b) => b.count - a.count),
    majorNotices: status.majorNotices.map((n) => ({
      appName: n.service.service ? `${n.displayName} · ${n.service.service}` : n.displayName,
      detail: describeMajorNotice(n.service),
    })),
  };
}

const issues = (p: DigestProjectRow) => p.failures + p.backupFailures + p.cronFailures;

/** One org's digest for a window. `withHost` adds host trends, for orgs with an instance admin. */
export async function collectDigestData(
  orgId: string,
  orgName: string,
  window: DigestWindow,
  opts: { withHost?: boolean; now?: Date } = {},
): Promise<DigestData> {
  const now = opts.now ?? new Date();
  const inWindow = (column: AnyPgColumn) => and(gte(column, window.since), lt(column, window.until));

  const [orgApps, orgProjects, orgCronJobs] = await Promise.all([
    db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      columns: { id: true, name: true, displayName: true, projectId: true, parentAppId: true, isSystemManaged: true, status: true, parked: true, lastRunningAt: true, exitReason: true },
    }),
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      columns: { id: true, name: true, displayName: true, isSystemManaged: true },
    }),
    db.query.cronJobs.findMany({
      where: eq(cronJobs.organizationId, orgId),
      columns: { id: true, name: true, appId: true },
    }),
  ]);
  const appIds = orgApps.map((a) => a.id);

  const [
    deployRows,
    backupRows,
    drillRows,
    drillFailRows,
    cronRuns,
    fired,
    resolvedCount,
    openCount,
    allStale,
    stoppedJobs,
    certs,
    updates,
    resources,
    scanRows,
    runRows,
    recapRows,
    summaries,
  ] = await Promise.all([
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
    db
      .select({ appId: backups.appId, appName: backups.appName, volume: backups.volumeName })
      .from(backups)
      .where(and(eq(backups.organizationId, orgId), inWindow(backups.verifiedAt), eq(backups.verifyOutcome, "failed"))),
    orgCronJobs.length
      ? db.query.cronJobRuns.findMany({
          where: and(inArray(cronJobRuns.cronJobId, orgCronJobs.map((j) => j.id)), inWindow(cronJobRuns.startedAt), eq(cronJobRuns.status, "failed")),
          columns: { cronJobId: true },
        })
      : Promise.resolve([]),
    db
      .select({ type: alertHistory.type, about: alertHistory.about })
      .from(alertHistory)
      .where(and(eq(alertHistory.organizationId, orgId), inWindow(alertHistory.firedAt))),
    db.select({ n: count() }).from(alertHistory).where(and(eq(alertHistory.organizationId, orgId), inWindow(alertHistory.resolvedAt))),
    db
      .select({ n: count() })
      .from(alertHistory)
      .where(and(eq(alertHistory.organizationId, orgId), isNull(alertHistory.resolvedAt), lt(alertHistory.firedAt, window.until))),
    import("@/lib/backups/runs").then(({ loadStaleVolumes }) => loadStaleVolumes(orgId, window.until.getTime())),
    loadStoppedBackupJobs(orgId, now).catch(() => []),
    expiringCerts(orgId, now),
    imageUpdates(orgId).catch(() => NO_IMAGE_UPDATES),
    opts.withHost ? hostTrends(window).catch(() => undefined) : Promise.resolve(undefined),
    db
      .select({
        appId: appSecurityScans.appId,
        status: appSecurityScans.status,
        criticalCount: appSecurityScans.criticalCount,
        warningCount: appSecurityScans.warningCount,
        startedAt: appSecurityScans.startedAt,
        completedAt: appSecurityScans.completedAt,
      })
      .from(appSecurityScans)
      .where(and(eq(appSecurityScans.organizationId, orgId), inWindow(appSecurityScans.startedAt)))
      .catch(() => []),
    db
      .select({ finishedAt: backupRuns.finishedAt })
      .from(backupRuns)
      .where(and(eq(backupRuns.organizationId, orgId), inWindow(backupRuns.finishedAt)))
      .catch(() => []),
    db
      .select({ appId: appRecaps.appId, deployedAt: appRecaps.deployedAt, dueAt: appRecaps.dueAt })
      .from(appRecaps)
      .where(and(eq(appRecaps.organizationId, orgId), eq(appRecaps.kind, "30d")))
      .catch(() => []),
    import("@/lib/metrics/history")
      .then(({ appSummaries }) => appSummaries(orgId, { from: window.since, to: window.until }))
      .catch(() => new Map<string, never>()),
  ]);

  // A stopped app's volumes wait for it; the digest lists them under backups on hold.
  const offApps = new Set(orgApps.filter((a) => appNotRunning(a)).map((a) => a.id));
  const stale = allStale.filter((v) => !v.appId || !offApps.has(v.appId));

  const deploys = {
    total: deployRows.length,
    succeeded: deployRows.filter((d) => d.status === "success").length,
    failed: deployRows.filter((d) => d.status === "failed").length,
  };

  const jobById = new Map(orgCronJobs.map((j) => [j.id, j]));
  const appById = new Map(orgApps.map((a) => [a.id, a]));
  const projectById = new Map(orgProjects.map((p) => [p.id, p]));
  const label = (a: { name: string; displayName: string | null }) => a.displayName || a.name;
  const topLevel = orgApps.filter((a) => !a.parentAppId && !a.isSystemManaged);

  const rows = new Map<string, DigestProjectRow & { appNames: Set<string> }>();
  const project = (appId: string | null) => {
    const app = appId ? appById.get(appId) : undefined;
    if (!app) return null;
    const parent = app.parentAppId ? appById.get(app.parentAppId) : undefined;
    const projectId = app.projectId ?? parent?.projectId ?? null;
    const owner = projectId ? projectById.get(projectId) : undefined;
    const key = owner ? owner.id : `app:${parent?.id ?? app.id}`;
    let row = rows.get(key);
    if (!row) {
      row = owner
        ? { id: owner.id, name: owner.displayName || owner.name, deploys: 0, failures: 0, backupFailures: 0, cronFailures: 0, appNames: new Set() }
        : { appId: parent?.id ?? app.id, name: label(parent ?? app), deploys: 0, failures: 0, backupFailures: 0, cronFailures: 0, appNames: new Set() };
      rows.set(key, row);
    }
    return row;
  };
  for (const a of topLevel) project(a.id)?.appNames.add(label(a));
  for (const d of deployRows) {
    const row = project(d.appId);
    if (!row) continue;
    row.deploys += 1;
    if (d.status === "failed") row.failures += 1;
  }
  for (const b of backupRows) {
    const row = project(b.appId);
    if (!row || (b.status !== "success" && b.status !== "failed")) continue;
    row.backups ??= { succeeded: 0, total: 0 };
    row.backups.total += 1;
    if (b.status === "success") row.backups.succeeded += 1;
    else row.backupFailures += 1;
  }
  for (const run of cronRuns) {
    const row = project(jobById.get(run.cronJobId)?.appId ?? null);
    if (row) row.cronFailures += 1;
  }
  for (const [appId, s] of summaries) {
    const row = project(appId);
    if (!row) continue;
    if (s.cpu) row.cpu = (row.cpu ?? 0) + s.cpu.avg;
    if (s.memory) row.memory = (row.memory ?? 0) + s.memory.avg;
  }

  const oom = new Map<string, number>();
  for (const f of fired) if (f.type === "app.oom") oom.set(f.about, (oom.get(f.about) ?? 0) + 1);
  const oomApps = [...oom]
    .flatMap(([appId, n]) => {
      const app = appById.get(appId);
      return app ? [{ appId, appName: label(app), count: n }] : [];
    })
    .sort((a, b) => b.count - a.count);

  const firstDeploy = new Map(recapRows.map((r) => [r.appId, r]));
  const newApps = recapRows
    .filter((r) => r.deployedAt >= window.since && r.deployedAt < window.until && appById.has(r.appId))
    .sort((a, b) => a.deployedAt.getTime() - b.deployedAt.getTime())
    .map((r) => ({ appId: r.appId, appName: label(appById.get(r.appId)!), deployedAt: r.deployedAt.toISOString(), monthRecapAt: r.dueAt >= now ? r.dueAt.toISOString() : null }));

  const lifecycleRows = appIds.length
    ? await db
        .select({ appId: activities.appId, action: activities.action, at: activities.createdAt })
        .from(activities)
        .where(
          and(
            eq(activities.organizationId, orgId),
            inArray(activities.appId, appIds),
            inArray(activities.action, ["app.started", "app.stopped"]),
            gte(activities.createdAt, new Date(window.since.getTime() - LIFECYCLE_LOOKBACK_MS)),
            lt(activities.createdAt, window.until),
          ),
        )
        .catch(() => [])
    : [];
  const lifecycle = lifecycleChanges(lifecycleRows.filter((r): r is LifecycleRow => !!r.appId), window).flatMap((c) => {
    const app = appById.get(c.appId);
    return app && !app.isSystemManaged ? [{ ...c, appName: label(app) }] : [];
  });

  const changes = await seenChanges(
    topLevel.map((a) => ({ id: a.id, name: label(a), firstDeployAt: firstDeploy.get(a.id)?.deployedAt ?? null })),
    window,
  ).catch(() => []);

  const projectRows = [...rows.values()]
    .filter((p) => p.id === undefined || !projectById.get(p.id)?.isSystemManaged)
    .map(({ appNames, ...p }): DigestProjectRow => (appNames.size > 1 ? { ...p, apps: [...appNames].sort() } : p));
  const active = projectRows
    .filter((p) => p.deploys + issues(p) > 0)
    .sort((a, b) => issues(b) - issues(a) || b.deploys - a.deploys);

  const drills = new Map(drillRows.map((r) => [r.outcome, r.n]));
  return {
    cadence: window.cadence,
    orgName,
    windowLabel: windowLabel(window),
    since: window.since.toISOString(),
    until: window.until.toISOString(),
    appCount: topLevel.length,
    deploys,
    deploysByBucket: deployBuckets(deployRows, window),
    backups: {
      succeeded: backupRows.filter((b) => b.status === "success").length,
      failed: backupRows.filter((b) => b.status === "failed").length,
      totalSize: backupRows.reduce((sum, b) => sum + (b.status === "success" ? b.size ?? 0 : 0), 0),
      drillsPassed: drills.get("verified") ?? 0,
      drillsFailed: drills.get("failed") ?? 0,
      staleVolumes: stale.length,
      ...backupRunRollup(runRows),
    },
    staleApps: staleByApp(stale),
    stoppedBackups: stoppedBackupApps(stoppedJobs, (id) => {
      const app = appById.get(id);
      return app ? label(app) : null;
    }),
    drillFailures: drillFailRows.map((r) => {
      const app = r.appId ? appById.get(r.appId) : undefined;
      return { appId: app?.id ?? null, appName: app ? label(app) : r.appName ?? "an app", volume: r.volume ?? "a volume" };
    }),
    oomApps,
    scans: scanRollup(scanRows),
    cron: {
      failed: cronRuns.length,
      affectedJobs: [...new Set(cronRuns.map((r) => jobById.get(r.cronJobId)?.name).filter((n): n is string => Boolean(n)))],
    },
    alerts: { fired: fired.length, resolved: resolvedCount[0]?.n ?? 0, open: openCount[0]?.n ?? 0, top: topAlerts(fired) },
    resources,
    newApps,
    lifecycle,
    changes,
    certs,
    ...updates,
    projects: active,
    quietProjects: projectRows.length - active.length,
  };
}

/** The bus event for a digest. */
export function digestEvent(data: DigestData): DigestHealthEvent {
  return {
    type: "digest.health",
    title: `${data.cadence === "monthly" ? "Monthly" : "Weekly"} digest: ${data.orgName}`,
    message: `${data.deploys.total} deploys, ${data.deploys.failed} failed; ${data.backups.failed} backup failures; ${data.alerts.fired} alerts.`,
    ...data,
  };
}
