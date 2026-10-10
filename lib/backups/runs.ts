// Backup runs: a start notice, failures as they happen and one summary when every job is done.

import { and, desc, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { apps, backupJobApps, backupJobs, backupRuns, backups, backupTargets, organizations, volumes } from "@/lib/db/schema";
import type { AlertItem } from "@/lib/bus/events";
import { formatDuration } from "@/lib/email/format";
import { logger } from "@/lib/logger";
import { emit } from "@/lib/notifications/dispatch";
import { fireAlert, settleAlerts } from "@/lib/notifications/observations";
import { readOrgNotificationSettings } from "@/lib/notifications/preferences";
import { skipsAsConfig } from "./bind-config";
import { isUncapturedSource } from "./coverage";
import { exclusionReason, isBackupSelected } from "./durability";
import {
  estimateRunMs,
  failureSubject,
  LONG_RUN_MS,
  MAX_SUMMARY_ROWS,
  needsAttention,
  nightlyRunKey,
  runDeadline,
  runIsDone,
  summarizeApps,
  summarizeResults,
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

async function backupConcurrency(): Promise<number> {
  const { loadResourceSettings, maxDeployConcurrency } = await import("@/lib/resources/host");
  await loadResourceSettings();
  return maxDeployConcurrency();
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
  return estimateRunMs(jobs, await backupConcurrency());
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

  const settings = await readOrgNotificationSettings(opts.organizationId);
  if (settings.categories.backupStarts && opts.plan.apps.length > 0) {
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
    .select({ id: backupJobs.id, organizationId: backupJobs.organizationId, time: organizations.nightlyBackupTime })
    .from(backupJobs)
    .innerJoin(organizations, eq(organizations.id, backupJobs.organizationId))
    .where(and(eq(backupJobs.enabled, true), eq(backupJobs.nightly, true)));
  const byOrg = new Map<string, { key: string; jobIds: string[] }>();
  for (const job of jobs) {
    const key = nightlyRunKey(job.time, now);
    if (!key || !job.organizationId) continue;
    const entry = byOrg.get(job.organizationId) ?? { key, jobIds: [] };
    entry.jobIds.push(job.id);
    byOrg.set(job.organizationId, entry);
  }

  const runOf = new Map<string, string>();
  for (const [organizationId, { key, jobIds }] of byOrg) {
    try {
      const plan = await planJobs(jobIds);
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
  const plan = await planJobs([job.id]);
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

function failureItem(item: BackupResultItem): AlertItem {
  const where = item.appName && item.appName !== item.volumeName ? `${item.appName} / ${item.volumeName}` : item.volumeName;
  const title = {
    backup: `Backup of ${where} failed`,
    drill: `Restore drill failed for ${where}`,
    restore: `Restore of ${where} failed`,
    import: `Import into ${where} failed`,
  }[item.kind];
  const next =
    item.kind === "drill"
      ? "The archive may not restore. Run a fresh backup and check it before you need it."
      : item.kind === "backup"
        ? "The last good backup is still there. Fix the cause, then run the job again."
        : "Nothing was changed past the point it failed. Check the log, then try again.";
  return {
    type: "backup.failure",
    about: failureSubject(item),
    severity: "critical",
    title,
    detail: `${item.error ?? "It failed without an error message."} ${next}`,
    appId: item.appId ?? undefined,
    appName: item.appName ?? undefined,
    facts: [
      ...(item.jobName ? [{ label: "Job", value: item.jobName }] : []),
      { label: "Volume", value: item.volumeName },
    ],
    since: item.at,
  };
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
 * failure, and everything lands in its run or the org's open run for the summary.
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
    for (const item of items.filter((i) => i.outcome === "failed")) {
      await fireAlert(organizationId, "backup.failure", failureItem(item), at);
    }
    await settleAlerts(organizationId, "backup.failure", items.filter((i) => i.outcome === "success").map(failureSubject), at);

    const runId =
      opts.runId ??
      (
        await db.query.backupRuns.findFirst({
          where: and(eq(backupRuns.organizationId, organizationId), isNull(backupRuns.finishedAt)),
          orderBy: [desc(backupRuns.startedAt)],
          columns: { id: true },
        })
      )?.id;
    if (!runId) return;
    await db
      .update(backupRuns)
      .set({ items: sql`${backupRuns.items} || ${JSON.stringify(items)}::jsonb` })
      .where(and(eq(backupRuns.id, runId), isNull(backupRuns.finishedAt)));
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

/** Earlier successful sizes per volume, oldest first, leaving out this run's own archives. */
async function loadHistory(organizationId: string, items: BackupResultItem[], now: number): Promise<Map<string, number[]>> {
  const backed = items.filter((i) => i.kind === "backup");
  const history = new Map<string, number[]>();
  if (backed.length === 0) return history;
  const exclude = backed.flatMap((i) => (i.backupId ? [i.backupId] : []));
  const rows = await db
    .select({ appId: backups.appId, volumeName: backups.volumeName, size: backups.sizeBytes })
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
    const sizes = history.get(key) ?? [];
    if (sizes.length < HISTORY_RUNS) sizes.unshift(row.size ?? 0);
    history.set(key, sizes);
  }
  return history;
}

/** Volumes backed up this week with no success in 48 hours. */
export async function loadStaleVolumes(organizationId: string, now: number) {
  const rows = await db
    .select({
      appName: sql<string | null>`coalesce(max(${apps.displayName}), ${backups.appName})`,
      volumeName: backups.volumeName,
      lastSuccess: sql<Date | null>`max(${backups.finishedAt}) filter (where ${backups.status} = 'success')`.mapWith((v) => (v ? new Date(v) : null)),
    })
    .from(backups)
    .leftJoin(apps, eq(apps.id, backups.appId))
    .where(and(eq(backups.organizationId, organizationId), gt(backups.startedAt, new Date(now - COVERED_DAYS * 86_400_000))))
    .groupBy(backups.appId, backups.appName, backups.volumeName);
  return rows
    .filter((r) => r.volumeName && (!r.lastSuccess || now - r.lastSuccess.getTime() > STALE_MS))
    .map((r) => ({ appName: r.appName ?? r.volumeName!, volumeName: r.volumeName!, lastSuccessAt: r.lastSuccess?.toISOString() ?? null }));
}

type RunRow = typeof backupRuns.$inferSelect;

async function sendSummary(run: RunRow, now: number): Promise<void> {
  const [settings, history, staleVolumes] = await Promise.all([
    readOrgNotificationSettings(run.organizationId),
    loadHistory(run.organizationId, run.items, now),
    loadStaleVolumes(run.organizationId, now),
  ]);
  const rows = summarizeResults(run.items, history);
  const unfinished = unfinishedJobs(run);
  if (rows.length === 0 && unfinished.length === 0) return;
  if (!settings.categories.backups && !needsAttention(rows, staleVolumes.length, unfinished.length)) return;

  const backed = rows.filter((r) => r.kind === "backup");
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
  });
}

/** Closes and summarizes every run whose jobs all reported or whose deadline passed. Safe across processes. */
export async function finishBackupRuns(now = Date.now()): Promise<void> {
  const open = await db.query.backupRuns.findMany({ where: isNull(backupRuns.finishedAt) });
  for (const run of open) {
    try {
      if (!runIsDone({ plan: run.plan, jobsDone: run.jobsDone, deadlineAt: run.deadlineAt.getTime() }, now)) continue;
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
