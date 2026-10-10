// Backup runs: when they start, how long they should take, when they're done and what the summary says. No I/O.

import type { BackupSummaryApp, BackupSummaryRow } from "@/lib/bus/events";
import { backupDrop } from "@/lib/email/templates/visuals";

export type BackupResultKind = "backup" | "drill" | "restore" | "import";

export type BackupResultItem = {
  kind: BackupResultKind;
  appId: string | null;
  appName: string | null;
  volumeName: string;
  jobId?: string | null;
  jobName?: string | null;
  outcome: "success" | "failed" | "skipped";
  sizeBytes?: number;
  durationMs?: number;
  error?: string;
  backupId?: string;
  /** ISO time the result came in. */
  at: string;
};

/** What a run is expected to cover, as the start notice lists it. */
export type BackupRunPlan = {
  /** `appIds` are the apps a job backs up. */
  jobs: { jobId: string; jobName: string; appIds?: string[] }[];
  /** `appName` is the display name. `lastBytes` sums each volume's last successful size. */
  apps: { appId: string | null; appName: string; volumes: string[]; lastBytes?: number }[];
  /** "System default · R2 backups/node-a", no credentials. */
  target: string | null;
};

/** A run's own job or restore that should take longer than this gets a start notice and a summary. */
export const LONG_RUN_MS = 10 * 60_000;

/** The summary sends by the deadline even if jobs never report: three times the estimate, within 1 to 6 hours. */
export const MIN_DEADLINE_MS = 60 * 60_000;
export const MAX_DEADLINE_MS = 6 * 60 * 60_000;

/** Rows past this are counted, not listed. */
export const MAX_SUMMARY_ROWS = 60;

/** `HH:MM`, 24-hour UTC. */
export const NIGHTLY_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function nightlyCron(time: string): string {
  const m = NIGHTLY_TIME.exec(time) ?? NIGHTLY_TIME.exec("02:00")!;
  return `${Number(m[2])} ${Number(m[1])} * * *`;
}

/** The nightly run's key for `now`, when `now` is its minute. Null otherwise. */
export function nightlyRunKey(time: string, now: Date): string | null {
  const m = NIGHTLY_TIME.exec(time);
  if (!m || now.getUTCHours() !== Number(m[1]) || now.getUTCMinutes() !== Number(m[2])) return null;
  return `nightly:${now.toISOString().slice(0, 10)}`;
}

/** Per volume outside its own timing: lease, row writes, container start. */
export const VOLUME_OVERHEAD_MS = 2_000;
/** Per job: loading it, retention pruning, reporting. */
export const JOB_OVERHEAD_MS = 10_000;

/**
 * Expected run time. Jobs take a slot each and back up their volumes one after another, so each
 * job's volumes are summed and the jobs queue FIFO over `concurrency` slots. A volume with no
 * history (null) takes the median of the rest. Null without any history.
 */
export function estimateRunMs(jobs: (number | null)[][], concurrency: number): number | null {
  const known = jobs.flat().filter((d): d is number => d !== null).sort((a, b) => a - b);
  if (known.length === 0) return null;
  const typical = known[Math.floor(known.length / 2)];
  const slots = new Array<number>(Math.max(1, concurrency)).fill(0);
  for (const volumes of jobs) {
    if (volumes.length === 0) continue;
    const ms = volumes.reduce<number>((sum, d) => sum + (d ?? typical) + VOLUME_OVERHEAD_MS, JOB_OVERHEAD_MS);
    const free = slots.indexOf(Math.min(...slots));
    slots[free] += ms;
  }
  return Math.round(Math.max(...slots));
}

export function runDeadline(startedAt: number, estimatedMs: number | null): number {
  const budget = estimatedMs === null ? MAX_DEADLINE_MS : Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, estimatedMs * 3));
  return startedAt + budget;
}

/** Every planned job reported, or the deadline passed. */
export function runIsDone(run: { plan: BackupRunPlan; jobsDone: string[]; deadlineAt: number }, now: number): boolean {
  if (now >= run.deadlineAt) return true;
  const done = new Set(run.jobsDone);
  return run.plan.jobs.every((j) => done.has(j.jobId));
}

/** Planned jobs that never reported. */
export function unfinishedJobs(run: { plan: BackupRunPlan; jobsDone: string[] }): string[] {
  const done = new Set(run.jobsDone);
  return run.plan.jobs.filter((j) => !done.has(j.jobId)).map((j) => j.jobName);
}

/** `appId:volume`, the key backup history is looked up by. */
export function volumeKey(appId: string | null, volumeName: string): string {
  return `${appId ?? ""}:${volumeName}`;
}

/** The throttle subject for a failure, so a flapping volume sends once until it succeeds. */
export function failureSubject(item: Pick<BackupResultItem, "kind" | "appId" | "volumeName">): string {
  return `${item.kind}:${volumeKey(item.appId, item.volumeName)}`;
}

const KIND_ORDER: Record<BackupResultKind, number> = { backup: 0, restore: 1, import: 2, drill: 3 };
const OUTCOME_ORDER = { failed: 0, skipped: 2, success: 3 } as const;

/**
 * One row per kind, app and volume, the latest result winning. Failures first, then
 * backups that shrank, then the rest by app.
 */
export function summarizeResults(items: BackupResultItem[], history: Map<string, number[]>): BackupSummaryRow[] {
  const rows = new Map<string, BackupSummaryRow>();
  for (const item of [...items].sort((a, b) => a.at.localeCompare(b.at))) {
    const key = `${item.kind}:${volumeKey(item.appId, item.volumeName)}`;
    const runs = (rows.get(key)?.runs ?? 0) + 1;
    rows.set(key, {
      kind: item.kind,
      appId: item.appId,
      appName: item.appName ?? item.volumeName,
      volumeName: item.volumeName,
      jobName: item.jobName ?? undefined,
      outcome: item.outcome,
      sizeBytes: item.sizeBytes ?? 0,
      durationMs: item.durationMs ?? 0,
      error: item.error,
      runs,
    });
  }

  const out: BackupSummaryRow[] = [];
  for (const row of rows.values()) {
    if (row.kind === "backup") {
      const past = history.get(volumeKey(row.appId, row.volumeName));
      if (past?.length) {
        row.history = past;
        row.previousSize = past.at(-1);
        if (row.outcome === "success") {
          row.shrunk = backupDrop(past, row.sizeBytes) ?? undefined;
          row.grew = row.shrunk ? undefined : (backupGrowth(row.previousSize!, row.sizeBytes) ?? undefined);
        }
      }
    }
    out.push(row);
  }

  const rank = (r: BackupSummaryRow) => (r.outcome === "failed" ? 0 : r.shrunk ? 1 : r.grew ? 2 : OUTCOME_ORDER[r.outcome]);
  return out.sort(
    (a, b) => rank(a) - rank(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.appName.localeCompare(b.appName) || a.volumeName.localeCompare(b.volumeName),
  );
}

/** Growth worth a look: half again as large and at least this much bigger. */
export const GROWTH_MIN_RATIO = 0.5;
export const GROWTH_MIN_BYTES = 32 * 1024 ** 2;

/** How much larger `current` is than `previous`, when it's big growth. */
export function backupGrowth(previous: number, current: number): { pct: number } | null {
  if (previous <= 0) return null;
  const delta = current - previous;
  if (delta < GROWTH_MIN_BYTES || delta / previous < GROWTH_MIN_RATIO) return null;
  return { pct: Math.round((delta / previous) * 100) };
}

/** Backup rows rolled up per app, by name. */
export function summarizeApps(rows: BackupSummaryRow[]): BackupSummaryApp[] {
  const apps = new Map<string, BackupSummaryApp & { now: number; before: number }>();
  for (const row of rows.filter((r) => r.kind === "backup")) {
    const key = row.appId ?? row.appName;
    const app = apps.get(key) ?? { appId: row.appId, appName: row.appName, volumes: 0, failed: 0, skipped: 0, sizeBytes: 0, now: 0, before: 0 };
    app.volumes++;
    if (row.outcome === "failed") app.failed++;
    if (row.outcome === "skipped") app.skipped++;
    if (row.outcome === "success") {
      app.sizeBytes += row.sizeBytes;
      if (row.previousSize !== undefined) {
        app.now += row.sizeBytes;
        app.before += row.previousSize;
      }
    }
    apps.set(key, app);
  }
  return [...apps.values()]
    .map(({ now, before, ...app }) => (before > 0 ? { ...app, change: (now - before) / before } : app))
    .sort((a, b) => a.appName.localeCompare(b.appName));
}

/** Whether the summary has something that needs a person: a failure, a shrink, a stale volume or a job that never finished. */
export function needsAttention(rows: BackupSummaryRow[], staleVolumes: number, unfinished = 0): boolean {
  return staleVolumes > 0 || unfinished > 0 || rows.some((r) => r.outcome === "failed" || r.shrunk);
}
