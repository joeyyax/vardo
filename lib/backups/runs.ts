// Backup runs: failures as they happen and one summary when every job is done, emailed when it needs a look.

import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { apps, backupJobApps, backupJobs, backupJobVolumes, backupRuns, backups, backupTargets, organizations, volumes } from "@/lib/db/schema";
import { formatDuration } from "@/lib/email/format";
import { logger } from "@/lib/logger";
import { emit } from "@/lib/notifications/dispatch";
import { fireAlert, settleAlerts } from "@/lib/notifications/observations";
import { readOrgNotificationSettings } from "@/lib/notifications/preferences";
import { skipsAsConfig } from "./bind-config";
import { backupLeaseHeld } from "./run-lease";
import { backupSlotLimit } from "./run-limit";
import { backupFailureItem } from "./failure-alert";
import { EMPTY_BIND_SKIP_LOG, isUncapturedSource, volumeCoverage, type VolumeCoverage } from "./coverage";
import type { BackupSummaryEvent } from "@/lib/bus/events";
import { UTC } from "@/lib/time-zone";
import { getInstanceTimeZone, resolveTimeZone } from "@/lib/time-zone-settings";
import { exclusionReason, isBackupSelected } from "./durability";
import {
  estimateRunMs,
  failureSubject,
  LONG_RUN_MS,
  MANUAL_RUN_PREFIX,
  MAX_SUMMARY_ROWS,
  missedNightlyKey,
  nightlyRunKey,
  runDeadline,
  runIsDone,
  summarizeApps,
  summarizeResults,
  summaryEmails,
  unfinishedJobs,
  volumeKey,
  type BackupResultItem,
  type BackupRunPlan,
} from "./run-rules";

const log = logger.child("backup-runs");

type RunKind = "nightly" | "job" | "restore";

/** Earlier sizes a summary compares against. */
const HISTORY_RUNS = 6;
const HISTORY_DAYS = 30;
/** Recent backups per volume an estimate averages. */
const ESTIMATE_RUNS = 3;
/** A volume backed up this recently counts as still covered. */
const COVERED_DAYS = 7;
/** Covered with no success this long is stale. */
const STALE_MS = 48 * 60 * 60_000;

/** Where a target writes, without credentials. */
export function describeTarget(target: { name: string; type: string; config: Record<string, unknown> }): string {
  const c = target.config;
  const where =
    target.type === "ssh"
      ? `${c.host ?? ""}:${c.path ?? ""}`
      : target.type === "local"
        ? String(c.path ?? "")
        : [c.bucket, typeof c.prefix === "string" ? c.prefix.replace(/^\/+|\/+$/g, "") : ""].filter(Boolean).join("/");
  const type = target.type.toUpperCase();
  const named = target.name.toUpperCase().includes(type);
  const detail = [named ? "" : type, where].filter(Boolean).join(" ");
  return detail ? `${target.name} · ${detail}` : target.name;
}

/** Each volume's average duration over its last few successful backups and its last size, by `appId:volume`. */
async function volumeHistory(
  organizationId: string | null,
  keys: string[],
  now: number,
): Promise<Map<string, { durationMs: number; lastBytes: number }>> {
  const out = new Map<string, { durationMs: number; lastBytes: number }>();
  if (keys.length === 0) return out;
  const names = [...new Set(keys.map((k) => k.slice(k.indexOf(":") + 1)))];
  const rows = await db
    .select({
      appId: backups.appId,
      volumeName: backups.volumeName,
      startedAt: backups.startedAt,
      finishedAt: backups.finishedAt,
      sizeBytes: backups.sizeBytes,
    })
    .from(backups)
    .where(
      and(
        organizationId ? eq(backups.organizationId, organizationId) : isNull(backups.organizationId),
        eq(backups.status, "success"),
        inArray(backups.volumeName, names),
        isNotNull(backups.finishedAt),
        gt(backups.startedAt, new Date(now - HISTORY_DAYS * 86_400_000)),
      ),
    )
    .orderBy(desc(backups.startedAt));
  const wanted = new Set(keys);
  const samples = new Map<string, { durations: number[]; lastBytes: number }>();
  for (const row of rows) {
    const key = volumeKey(row.appId, row.volumeName ?? "");
    if (!wanted.has(key)) continue;
    const entry = samples.get(key) ?? { durations: [], lastBytes: row.sizeBytes ?? 0 };
    if (entry.durations.length < ESTIMATE_RUNS) entry.durations.push(row.finishedAt!.getTime() - row.startedAt.getTime());
    samples.set(key, entry);
  }
  for (const [key, { durations, lastBytes }] of samples) {
    out.set(key, { durationMs: durations.reduce((a, b) => a + b, 0) / durations.length, lastBytes });
  }
  return out;
}

/** What these jobs will back up, grouped by app, and where. */
export async function planJobs(jobIds: string[]): Promise<BackupRunPlan> {
  if (jobIds.length === 0) return { jobs: [], apps: [], target: null };
  const jobs = await db.query.backupJobs.findMany({
    where: inArray(backupJobs.id, jobIds),
    columns: { id: true, name: true, targetId: true },
  });
  const links = await db
    .select({ jobId: backupJobApps.backupJobId, appId: apps.id, appName: apps.displayName, status: apps.status })
    .from(backupJobApps)
    .innerJoin(apps, eq(apps.id, backupJobApps.appId))
    .where(inArray(backupJobApps.backupJobId, jobIds));
  const live = links.filter((l) => l.status !== "missing");
  const vols = live.length
    ? await db.query.volumes.findMany({ where: inArray(volumes.appId, live.map((l) => l.appId)) })
    : [];
  const byApp = new Map<string, string[]>();
  for (const v of vols) {
    if (!v.appId || v.removedAt || !isBackupSelected(v) || exclusionReason(v.durability) || isUncapturedSource(v)) continue;
    if (await skipsAsConfig(v)) continue;
    byApp.set(v.appId, [...(byApp.get(v.appId) ?? []), v.name]);
  }
  const targetIds = [...new Set(jobs.map((j) => j.targetId))];
  const targets = await db.query.backupTargets.findMany({ where: inArray(backupTargets.id, targetIds) });
  const described = [...new Set(targets.map((t) => describeTarget({ ...t, config: t.config as Record<string, unknown> })))];
  return {
    jobs: jobs.map((j) => ({
      jobId: j.id,
      jobName: j.name,
      appIds: live.filter((l) => l.jobId === j.id && byApp.has(l.appId)).map((l) => l.appId),
    })),
    apps: [...new Map(live.map((l) => [l.appId, l])).values()]
      .filter((l) => byApp.has(l.appId))
      .map((l) => ({ appId: l.appId, appName: l.appName, volumes: byApp.get(l.appId)!.sort() }))
      .sort((a, b) => a.appName.localeCompare(b.appName)),
    target: described.length ? described.join(", ") : null,
  };
}

/** Estimates the run and fills in each app's last size. */
async function estimatePlan(organizationId: string | null, plan: BackupRunPlan, now: number): Promise<number | null> {
  const keys = plan.apps.flatMap((a) => a.volumes.map((v) => volumeKey(a.appId, v)));
  const history = await volumeHistory(organizationId, keys, now);
  const appKeys = new Map(plan.apps.map((a) => [a.appId, a.volumes.map((v) => volumeKey(a.appId, v))]));
  for (const app of plan.apps) {
    const known = appKeys.get(app.appId)!.flatMap((k) => (history.has(k) ? [history.get(k)!.lastBytes] : []));
    if (known.length) app.lastBytes = known.reduce((a, b) => a + b, 0);
  }
  const jobs = plan.jobs.map((j) =>
    (j.appIds ?? []).flatMap((id) => (appKeys.get(id) ?? []).map((k) => history.get(k)?.durationMs ?? null)),
  );
  return estimateRunMs(jobs, await backupSlotLimit());
}

/** Opens a run once per key and sends its start notice. Null when another process opened it. */
async function openRun(opts: {
  organizationId: string;
  kind: RunKind;
  runKey: string;
  label: string;
  plan: BackupRunPlan;
  estimatedMs: number | null;
  now: number;
}): Promise<string | null> {
  const id = nanoid();
  const [opened] = await db
    .insert(backupRuns)
    .values({
      id,
      organizationId: opts.organizationId,
      kind: opts.kind,
      runKey: opts.runKey,
      label: opts.label,
      startedAt: new Date(opts.now),
      estimatedMs: opts.estimatedMs,
      deadlineAt: new Date(runDeadline(opts.now, opts.estimatedMs)),
      plan: opts.plan,
    })
    .onConflictDoNothing()
    .returning({ id: backupRuns.id });
  if (!opened) return null;

  // Webhooks get the start notice; email leaves it out.
  if (opts.plan.apps.length > 0) {
    const volumeCount = opts.plan.apps.reduce((n, a) => n + a.volumes.length, 0);
    emit(opts.organizationId, {
      type: "backup.run-started",
      title: `${opts.label} starting`,
      message: `${volumeCount} volume${volumeCount === 1 ? "" : "s"} across ${opts.plan.apps.length} app${opts.plan.apps.length === 1 ? "" : "s"}${opts.estimatedMs ? `, about ${formatDuration(opts.estimatedMs)}` : ""}.`,
      runId: id,
      kind: opts.kind,
      label: opts.label,
      apps: opts.plan.apps,
      volumeCount,
      estimatedMs: opts.estimatedMs,
      target: opts.plan.target,
    });
  }
  return id;
}

/** Opens each org's nightly run at its time. Returns the run each nightly job belongs to. */
export async function startNightlyRuns(now: Date): Promise<Map<string, string>> {
  const jobs = await db
    .select({
      id: backupJobs.id,
      organizationId: backupJobs.organizationId,
      time: organizations.nightlyBackupTime,
      timeZone: organizations.timeZone,
    })
    .from(backupJobs)
    .innerJoin(organizations, eq(organizations.id, backupJobs.organizationId))
    .where(and(eq(backupJobs.enabled, true), eq(backupJobs.nightly, true)));
  const instanceTimeZone = jobs.length ? await getInstanceTimeZone() : UTC;
  const byOrg = new Map<string, { key: string; missed: boolean; jobIds: string[] }>();
  for (const job of jobs) {
    if (!job.organizationId) continue;
    const tz = resolveTimeZone(job.timeZone, instanceTimeZone);
    const onTime = nightlyRunKey(job.time, now, tz);
    const key = onTime ?? missedNightlyKey(job.time, now, tz);
    if (!key) continue;
    const entry = byOrg.get(job.organizationId) ?? { key, missed: !onTime, jobIds: [] };
    entry.jobIds.push(job.id);
    byOrg.set(job.organizationId, entry);
  }

  const runOf = new Map<string, string>();
  for (const [organizationId, { key, missed, jobIds }] of byOrg) {
    try {
      // A run a stopped console missed starts once, as the whole nightly run.
      if (missed) {
        const opened = await db.query.backupRuns.findFirst({
          where: and(eq(backupRuns.organizationId, organizationId), eq(backupRuns.runKey, key)),
          columns: { id: true },
        });
        if (opened) continue;
      }
      const plan: BackupRunPlan = { ...(await planJobs(jobIds)), jobLeases: true };
      const estimatedMs = await estimatePlan(organizationId, plan, now.getTime());
      const runId = await openRun({ organizationId, kind: "nightly", runKey: key, label: "Nightly backups", plan, estimatedMs, now: now.getTime() });
      if (runId) for (const jobId of jobIds) runOf.set(jobId, runId);
    } catch (err) {
      log.error(`Nightly run for org ${organizationId} didn't start:`, err);
    }
  }
  return runOf;
}

/** Opens a run for one job expected to take longer than LONG_RUN_MS. Null for a quick one. */
export async function startJobRun(job: { id: string; name: string; organizationId: string | null }, now: Date): Promise<string | null> {
  if (!job.organizationId) return null;
  const plan: BackupRunPlan = { ...(await planJobs([job.id])), jobLeases: true };
  const estimatedMs = await estimatePlan(job.organizationId, plan, now.getTime());
  if (estimatedMs === null || estimatedMs < LONG_RUN_MS) return null;
  return openRun({
    organizationId: job.organizationId,
    kind: "job",
    runKey: `job:${job.id}:${Math.floor(now.getTime() / 60_000)}`,
    label: job.name,
    plan,
    estimatedMs,
    now: now.getTime(),
  });
}

/** Opens a run for a job someone started by hand, so its results stay out of another run's summary. `appIds` scopes it to those apps. */
export async function startManualRun(
  job: { id: string; name: string; organizationId: string | null },
  now: Date,
  appIds?: string[],
): Promise<string | null> {
  if (!job.organizationId) return null;
  return openRun({
    organizationId: job.organizationId,
    kind: "job",
    runKey: `${MANUAL_RUN_PREFIX}${job.id}:${now.getTime()}`,
    label: job.name,
    plan: { jobs: [{ jobId: job.id, jobName: job.name, ...(appIds ? { appIds } : {}) }], apps: [], target: null },
    estimatedMs: null,
    now: now.getTime(),
  });
}

/** When a nightly run covering the job started at or after `since`. Null for none. */
export async function nightlyRunStartedSince(jobId: string, since: Date): Promise<Date | null> {
  const run = await db.query.backupRuns.findFirst({
    where: and(
      eq(backupRuns.kind, "nightly"),
      gte(backupRuns.startedAt, since),
      sql`${backupRuns.plan}->'jobs' @> ${JSON.stringify([{ jobId }])}::jsonb`,
    ),
    columns: { startedAt: true },
  });
  return run?.startedAt ?? null;
}

/** When a nightly run started, the time its jobs are due. Null for a run of another kind. */
export async function nightlyRunStart(runId: string): Promise<Date | null> {
  const run = await db.query.backupRuns.findFirst({
    where: and(eq(backupRuns.id, runId), eq(backupRuns.kind, "nightly")),
    columns: { startedAt: true },
  });
  return run?.startedAt ?? null;
}

/**
 * Takes the latest whole-job manual run of the job started at or after `since` that finished with results
 * as the job's result in a nightly run, marking it done there once. False when there's none to take.
 */
export async function adoptManualRun(runId: string, jobId: string, since: Date): Promise<boolean> {
  const manual = await db.query.backupRuns.findMany({
    where: and(
      sql`starts_with(${backupRuns.runKey}, ${`${MANUAL_RUN_PREFIX}${jobId}:`})`,
      gte(backupRuns.startedAt, since),
      sql`${backupRuns.jobsDone} @> ${JSON.stringify([jobId])}::jsonb`,
    ),
    orderBy: [desc(backupRuns.startedAt)],
  });
  const items = manual
    .filter((r) => !r.plan.jobs.some((j) => j.jobId === jobId && j.appIds))
    .map((r) => r.items.filter((i) => i.jobId === jobId))
    .find((found) => found.length > 0);
  if (!items) return false;
  await db
    .update(backupRuns)
    .set({
      items: sql`${backupRuns.items} || ${JSON.stringify(items)}::jsonb`,
      jobsDone: sql`${backupRuns.jobsDone} || ${JSON.stringify([jobId])}::jsonb`,
    })
    .where(and(eq(backupRuns.id, runId), isNull(backupRuns.finishedAt), sql`not ${backupRuns.jobsDone} @> ${JSON.stringify([jobId])}::jsonb`));
  return true;
}

/** Opens a run for a restore whose backup took longer than LONG_RUN_MS to take. Null for a quick one. */
export async function startRestoreRun(backup: {
  id: string;
  organizationId: string | null;
  appId: string | null;
  appName: string | null;
  volumeName: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}): Promise<string | null> {
  if (!backup.organizationId || !backup.finishedAt) return null;
  const estimatedMs = backup.finishedAt.getTime() - backup.startedAt.getTime();
  if (estimatedMs < LONG_RUN_MS) return null;
  const now = Date.now();
  const app = backup.appId
    ? await db.query.apps.findFirst({ where: eq(apps.id, backup.appId), columns: { displayName: true } })
    : undefined;
  const appName = app?.displayName ?? backup.appName ?? backup.volumeName ?? "a volume";
  return openRun({
    organizationId: backup.organizationId,
    kind: "restore",
    runKey: `restore:${backup.id}:${Math.floor(now / 60_000)}`,
    label: `Restore of ${appName}`,
    plan: { jobs: [{ jobId: `restore:${backup.id}`, jobName: `Restore of ${appName}` }], apps: [{ appId: backup.appId, appName, volumes: [backup.volumeName ?? ""] }], target: null },
    estimatedMs,
    now,
  });
}

/** Each failed backup volume's last successful backup time by `appId:volume`, null for none. Empty when the lookup fails. */
async function lastGoodBackups(organizationId: string, items: BackupResultItem[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const failed = items.filter((i) => i.kind === "backup" && i.outcome === "failed");
  if (failed.length === 0) return out;
  try {
    const rows = await db
      .select({
        appId: backups.appId,
        volumeName: backups.volumeName,
        at: sql<Date | null>`max(${backups.finishedAt})`.mapWith((v) => (v ? new Date(v) : null)),
      })
      .from(backups)
      .where(
        and(
          eq(backups.organizationId, organizationId),
          eq(backups.status, "success"),
          inArray(backups.volumeName, [...new Set(failed.map((i) => i.volumeName))]),
        ),
      )
      .groupBy(backups.appId, backups.volumeName);
    const found = new Map(rows.map((r) => [volumeKey(r.appId, r.volumeName ?? ""), r.at?.toISOString() ?? null]));
    for (const i of failed) out.set(volumeKey(i.appId, i.volumeName), found.get(volumeKey(i.appId, i.volumeName)) ?? null);
  } catch (err) {
    log.warn(`Couldn't look up last good backups for org ${organizationId}:`, err);
  }
  return out;
}

async function orgTimeZone(organizationId: string): Promise<string> {
  try {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, organizationId), columns: { timeZone: true } });
    return resolveTimeZone(org?.timeZone, await getInstanceTimeZone());
  } catch {
    return UTC;
  }
}

/** Items with each app's display name in place of whatever the producer had. */
async function withDisplayNames(items: BackupResultItem[]): Promise<BackupResultItem[]> {
  const ids = [...new Set(items.flatMap((i) => (i.appId ? [i.appId] : [])))];
  if (ids.length === 0) return items;
  const rows = await db.query.apps.findMany({ where: inArray(apps.id, ids), columns: { id: true, displayName: true } });
  const names = new Map((rows ?? []).map((r) => [r.id, r.displayName]));
  return items.map((i) => (i.appId && names.get(i.appId) ? { ...i, appName: names.get(i.appId)! } : i));
}

/**
 * Takes results as they come: failures email now through the throttle, a success clears its
 * failure, and results with a run land in it for the summary. The digest counts the rest.
 */
export async function recordBackupResults(
  organizationId: string,
  items: BackupResultItem[],
  opts: { runId?: string | null } = {},
  now = Date.now(),
): Promise<void> {
  if (items.length === 0) return;
  try {
    items = await withDisplayNames(items);
    const at = new Date(now);
    const failed = items.filter((i) => i.outcome === "failed");
    if (failed.length) {
      const [lastGood, timeZone] = await Promise.all([lastGoodBackups(organizationId, failed), orgTimeZone(organizationId)]);
      for (const item of failed) {
        const key = volumeKey(item.appId, item.volumeName);
        await fireAlert(organizationId, "backup.failure", backupFailureItem(item, { lastGoodAt: lastGood.has(key) ? lastGood.get(key) : undefined, timeZone }), at);
      }
    }
    await settleAlerts(organizationId, "backup.failure", items.filter((i) => i.outcome === "success").map(failureSubject), at);

    if (!opts.runId) return;
    await db
      .update(backupRuns)
      .set({ items: sql`${backupRuns.items} || ${JSON.stringify(items)}::jsonb` })
      .where(and(eq(backupRuns.id, opts.runId), isNull(backupRuns.finishedAt)));
  } catch (err) {
    log.error(`Couldn't record backup results for org ${organizationId}:`, err);
  }
}

/** A job in the run finished, whatever its outcome. */
export async function markJobDone(runId: string, jobId: string): Promise<void> {
  await db
    .update(backupRuns)
    .set({ jobsDone: sql`${backupRuns.jobsDone} || ${JSON.stringify([jobId])}::jsonb` })
    .where(and(eq(backupRuns.id, runId), isNull(backupRuns.finishedAt)));
}

/** Earlier successful sizes per volume, oldest first, and when the latest finished, leaving out this run's own archives. */
async function loadHistory(
  organizationId: string,
  items: BackupResultItem[],
  now: number,
): Promise<{ history: Map<string, number[]>; lastGood: Map<string, string> }> {
  const backed = items.filter((i) => i.kind === "backup");
  const history = new Map<string, number[]>();
  const lastGood = new Map<string, string>();
  if (backed.length === 0) return { history, lastGood };
  const exclude = backed.flatMap((i) => (i.backupId ? [i.backupId] : []));
  const rows = await db
    .select({ appId: backups.appId, volumeName: backups.volumeName, size: backups.sizeBytes, finishedAt: backups.finishedAt })
    .from(backups)
    .where(
      and(
        eq(backups.organizationId, organizationId),
        eq(backups.status, "success"),
        inArray(backups.volumeName, [...new Set(backed.map((i) => i.volumeName))]),
        gt(backups.startedAt, new Date(now - HISTORY_DAYS * 86_400_000)),
        ...(exclude.length ? [notInArray(backups.id, exclude)] : []),
      ),
    )
    .orderBy(desc(backups.startedAt));
  for (const row of rows) {
    const key = volumeKey(row.appId, row.volumeName ?? "");
    if (!lastGood.has(key) && row.finishedAt) lastGood.set(key, row.finishedAt.toISOString());
    const sizes = history.get(key) ?? [];
    if (sizes.length < HISTORY_RUNS) sizes.unshift(row.size ?? 0);
    history.set(key, sizes);
  }
  return { history, lastGood };
}

/** Why a scheduled run skips each app, null when it takes it. Retired and unknown apps are left out. */
async function appScheduleReasons(appIds: string[]): Promise<Map<string, string | null>> {
  const { getSystemBackupsDefault, resolveBackupSwitch } = await import("./switch");
  const [rows, links, systemDefault] = await Promise.all([
    db.query.apps.findMany({
      where: inArray(apps.id, appIds),
      columns: { id: true, organizationId: true, status: true, backupsEnabled: true },
      with: { organization: { columns: { backupsEnabled: true } } },
    }),
    db.query.backupJobApps.findMany({
      where: inArray(backupJobApps.appId, appIds),
      with: { backupJob: { columns: { organizationId: true, enabled: true } } },
    }),
    getSystemBackupsDefault().catch(() => true),
  ]);
  const orgOf = new Map((rows ?? []).map((a) => [a.id, a.organizationId]));
  const inJob = new Set(
    (links ?? [])
      .filter((l) => l.backupJob.enabled && (l.backupJob.organizationId === null || l.backupJob.organizationId === orgOf.get(l.appId)))
      .map((l) => l.appId),
  );
  return new Map(
    (rows ?? [])
      .filter((a) => a.status !== "missing")
      .map((a) => [
        a.id,
        !resolveBackupSwitch(a.backupsEnabled, a.organization?.backupsEnabled, systemDefault).enabled
          ? "Backups are off for the app"
          : inJob.has(a.id)
            ? null
            : "No backup job covers the app",
      ]),
  );
}

/** Each live volume of these apps with whether a scheduled run backs it up. */
async function coverageOf(appIds: string[]): Promise<{ appId: string; volumeName: string; coverage: VolumeCoverage }[]> {
  if (appIds.length === 0) return [];
  const [vols, schedule] = await Promise.all([
    db.query.volumes.findMany({ where: and(inArray(volumes.appId, appIds), isNull(volumes.removedAt)) }),
    appScheduleReasons(appIds),
  ]);
  const linked = vols.length
    ? await db.query.backupJobVolumes.findMany({
        where: inArray(backupJobVolumes.volumeId, vols.map((v) => v.id)),
        with: { backupJob: { columns: { enabled: true } } },
      })
    : [];
  const direct = new Set((linked ?? []).filter((l) => l.backupJob.enabled).map((l) => l.volumeId));
  const out: { appId: string; volumeName: string; coverage: VolumeCoverage }[] = [];
  for (const v of vols) {
    if (!v.appId) continue;
    const coverage = await volumeCoverage(v, {
      direct: direct.has(v.id),
      appReason: schedule.get(v.appId),
      configReason: () => skipsAsConfig(v),
    });
    out.push({ appId: v.appId, volumeName: v.name, coverage });
  }
  return out;
}

/** `appId:volume` keys of the volumes a job still backs up, out of these apps'. */
export async function stillBackedUp(appIds: string[]): Promise<Set<string>> {
  const covered = (await coverageOf(appIds)).filter((c) => c.coverage.covered);
  return new Set(covered.map((c) => volumeKey(c.appId, c.volumeName)));
}

/** The org's volumes a nightly run doesn't back up, with why, by app then volume. */
export async function loadNotBackedUp(organizationId: string): Promise<NonNullable<BackupSummaryEvent["notBackedUp"]>> {
  const orgApps = await db.query.apps.findMany({
    where: eq(apps.organizationId, organizationId),
    columns: { id: true, displayName: true },
  });
  const nameOf = new Map((orgApps ?? []).map((a) => [a.id, a.displayName]));
  const out: NonNullable<BackupSummaryEvent["notBackedUp"]> = [];
  for (const { appId, volumeName, coverage } of await coverageOf([...nameOf.keys()])) {
    if (coverage.covered || !coverage.reason) continue;
    out.push({ appId, appName: nameOf.get(appId) ?? appId, volumeName, reason: coverage.reason });
  }
  return out.sort((a, b) => a.appName.localeCompare(b.appName) || a.volumeName.localeCompare(b.volumeName));
}

/** Volumes backed up this week that a job still backs up, with no success in 48 hours. */
export async function loadStaleVolumes(organizationId: string, now: number) {
  // Grouped by app ID alone, so a rename doesn't split a volume in two.
  const rows = await db
    .select({
      appId: backups.appId,
      recordedName: sql<string | null>`max(${backups.appName})`,
      volumeName: backups.volumeName,
      lastSuccess: sql<Date | null>`max(${backups.finishedAt}) filter (where ${backups.status} = 'success')`.mapWith((v) => (v ? new Date(v) : null)),
    })
    .from(backups)
    .where(
      and(
        eq(backups.organizationId, organizationId),
        gt(backups.startedAt, new Date(now - COVERED_DAYS * 86_400_000)),
        // Leaves out skips of an empty bind source that never held data, as the engine does.
        sql`(${backups.status} <> 'skipped' or coalesce(${backups.log}, '') not like ${`%${EMPTY_BIND_SKIP_LOG}%`})`,
      ),
    )
    .groupBy(backups.appId, backups.volumeName);
  const stale = rows.filter((r) => r.volumeName && (!r.lastSuccess || now - r.lastSuccess.getTime() > STALE_MS));
  const appIds = [...new Set(stale.flatMap((r) => (r.appId ? [r.appId] : [])))];
  // A volume the engine now skips, or a deploy removed, leaves rows behind for the week.
  const [current, names] = await Promise.all([
    stillBackedUp(appIds),
    appIds.length
      ? db.query.apps.findMany({ where: inArray(apps.id, appIds), columns: { id: true, displayName: true } })
      : [],
  ]);
  const nameOf = new Map((names ?? []).map((a) => [a.id, a.displayName]));
  return stale
    .filter((r) => !r.appId || current.has(volumeKey(r.appId, r.volumeName!)))
    .map((r) => ({
      appId: r.appId,
      appName: (r.appId && nameOf.get(r.appId)) || r.recordedName || r.volumeName!,
      volumeName: r.volumeName!,
      lastSuccessAt: r.lastSuccess?.toISOString() ?? null,
    }));
}

type RunRow = typeof backupRuns.$inferSelect;

/** Stale volumes a run's summary lists: the org's for a nightly run, otherwise only those of the apps the run covered. */
export function staleForRun<T extends { appId: string | null }>(
  run: { kind: string; plan: BackupRunPlan; items: BackupResultItem[] },
  stale: T[],
): T[] {
  if (run.kind === "nightly") return stale;
  const covered = new Set([
    ...run.plan.apps.map((a) => a.appId),
    ...(run.plan.jobs.flatMap((j) => j.appIds ?? [])),
    ...run.items.map((i) => i.appId),
  ]);
  return stale.filter((v) => covered.has(v.appId));
}

/** Unfinished job name to its app, for jobs that back up one. */
function unfinishedAppIds(plan: BackupRunPlan, unfinished: string[]): Record<string, string> | undefined {
  const names = new Set(unfinished);
  const out = Object.fromEntries(plan.jobs.flatMap((j) => (names.has(j.jobName) && j.appIds?.length === 1 ? [[j.jobName, j.appIds[0]]] : [])));
  return Object.keys(out).length ? out : undefined;
}

/** Unfinished job names with no backup row in the run. */
async function jobsNotStarted(run: RunRow): Promise<string[]> {
  if (run.kind === "restore") return [];
  const done = new Set(run.jobsDone);
  const waiting = run.plan.jobs.filter((j) => !done.has(j.jobId));
  if (waiting.length === 0) return [];
  const rows = await db.query.backups.findMany({
    where: and(inArray(backups.jobId, waiting.map((j) => j.jobId)), gte(backups.startedAt, run.startedAt)),
    columns: { jobId: true },
  });
  const started = new Set((rows ?? []).map((r) => r.jobId));
  return waiting.filter((j) => !started.has(j.jobId)).map((j) => j.jobName);
}

async function sendSummary(run: RunRow, now: number): Promise<void> {
  const [settings, { history, lastGood }, orgStale] = await Promise.all([
    readOrgNotificationSettings(run.organizationId),
    loadHistory(run.organizationId, run.items, now),
    loadStaleVolumes(run.organizationId, now),
  ]);
  const staleVolumes = staleForRun(run, orgStale);
  const rows = summarizeResults(run.items, history, lastGood);
  const unfinished = unfinishedJobs(run);
  if (rows.length === 0 && unfinished.length === 0) return;
  const { send, problemsOnly } = summaryEmails(run, rows, staleVolumes.length, unfinished.length, settings.categories.backupSummaries);
  // A clean scheduled run goes to the digest.
  if (!send) return;
  const notBackedUp = run.kind === "nightly" ? await loadNotBackedUp(run.organizationId) : [];
  const notStarted = unfinished.length ? await jobsNotStarted(run).catch(() => []) : [];

  const backed = rows.filter((r) => r.kind === "backup" && !r.config);
  const succeeded = backed.filter((r) => r.outcome === "success").length;
  const failed = rows.filter((r) => r.outcome === "failed").length;
  emit(run.organizationId, {
    type: "backup.summary",
    title: failed > 0 ? `${run.label}: ${failed} failed` : `${run.label} finished`,
    message: `${succeeded} of ${backed.length} backups succeeded${failed ? `, ${failed} failed` : ""}.`,
    run: {
      kind: run.kind as RunKind,
      label: run.label,
      estimatedMs: run.estimatedMs,
      actualMs: now - run.startedAt.getTime(),
      unfinished: unfinished.length ? unfinished : undefined,
      notStarted: notStarted.length ? notStarted : undefined,
      unfinishedAppIds: unfinished.length ? unfinishedAppIds(run.plan, unfinished) : undefined,
      ...(problemsOnly ? { problemsOnly: true } : {}),
    },
    windowStart: run.startedAt.toISOString(),
    windowEnd: new Date(now).toISOString(),
    succeeded,
    failed: backed.filter((r) => r.outcome === "failed").length,
    skipped: backed.filter((r) => r.outcome === "skipped").length,
    totalSize: backed.reduce((sum, r) => sum + (r.outcome === "success" ? r.sizeBytes : 0), 0),
    durationMs: backed.reduce((sum, r) => sum + r.durationMs, 0),
    rows: rows.slice(0, MAX_SUMMARY_ROWS),
    hiddenRows: rows.length > MAX_SUMMARY_ROWS ? rows.length - MAX_SUMMARY_ROWS : undefined,
    apps: summarizeApps(rows),
    staleVolumes: staleVolumes.length ? staleVolumes : undefined,
    notBackedUp: notBackedUp.length ? notBackedUp : undefined,
  });
}

/** Now while one of the run's backups holds a live lease, else when its latest result came in. */
async function lastProgressAt(run: RunRow, now: number): Promise<number | null> {
  const jobIds = run.plan.jobs.map((j) => j.jobId);
  const running = jobIds.length
    ? await db.query.backups.findMany({
        where: and(inArray(backups.jobId, jobIds), eq(backups.status, "running"), gte(backups.startedAt, run.startedAt)),
        columns: { id: true },
      })
    : [];
  for (const row of running ?? []) {
    if (await backupLeaseHeld(row.id).catch(() => false)) return now;
  }
  const times = (run.items ?? []).map((i) => Date.parse(i.at)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/** Closes and summarizes every run whose jobs all reported, or that stopped progressing past its deadline. Safe across processes. */
export async function finishBackupRuns(now = Date.now()): Promise<void> {
  const open = await db.query.backupRuns.findMany({ where: isNull(backupRuns.finishedAt) });
  for (const run of open) {
    try {
      const deadlineAt = run.deadlineAt.getTime();
      const progress = now >= deadlineAt ? await lastProgressAt(run, now) : null;
      if (!runIsDone({ plan: run.plan, jobsDone: run.jobsDone, deadlineAt, startedAt: run.startedAt.getTime(), lastProgressAt: progress }, now)) continue;
      const [claimed] = await db
        .update(backupRuns)
        .set({ finishedAt: new Date(now) })
        .where(and(eq(backupRuns.id, run.id), isNull(backupRuns.finishedAt)))
        .returning();
      if (claimed) await sendSummary(claimed, now);
    } catch (err) {
      log.error(`Backup run ${run.id} didn't finish cleanly:`, err);
    }
  }
}
