// Backup runs: when they start, how long they should take, when they're done and what the summary says. No I/O.

import type { BackupSummaryApp, BackupSummaryRow } from "@/lib/bus/events";
import { backupDrop } from "@/lib/email/templates/visuals";
import { UTC, zonedDateKey, zonedParts, zonedTimeToUtc } from "@/lib/time-zone";

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
  /** A skip that's routine: the app is stopped, or the source can't be or needn't be captured. */
  expected?: boolean;
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

/** `HH:MM`, 24-hour, in the org's time zone. */
export const NIGHTLY_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function nightlyCron(time: string): string {
  const m = NIGHTLY_TIME.exec(time) ?? NIGHTLY_TIME.exec("02:00")!;
  return `${Number(m[2])} ${Number(m[1])} * * *`;
}

/** The nightly run's key for `now`, when `now` is its minute in `tz`. Null otherwise. DST-safe: a skipped time runs after the jump, a repeated one once. */
export function nightlyRunKey(time: string, now: Date, tz: string = UTC): string | null {
  const m = NIGHTLY_TIME.exec(time);
  if (!m) return null;
  const today = zonedParts(now, tz);
  const due = zonedTimeToUtc({ ...today, hour: Number(m[1]), minute: Number(m[2]) }, tz);
  if (Math.floor(now.getTime() / 60_000) !== Math.floor(due.getTime() / 60_000)) return null;
  return `nightly:${zonedDateKey(now, tz)}`;
}

/** How long after its time a nightly run a stopped console missed still starts. */
export const NIGHTLY_CATCH_UP_MS = 6 * 60 * 60_000;

/** The key of the latest nightly run due before `now`'s minute and within `windowMs`. Null otherwise. */
export function missedNightlyKey(time: string, now: Date, tz: string = UTC, windowMs = NIGHTLY_CATCH_UP_MS): string | null {
  const m = NIGHTLY_TIME.exec(time);
  if (!m) return null;
  const minute = Math.floor(now.getTime() / 60_000) * 60_000;
  const today = zonedParts(now, tz);
  for (const daysBack of [0, 1]) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day - daysBack));
    const day = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const due = zonedTimeToUtc({ ...day, hour: Number(m[1]), minute: Number(m[2]) }, tz);
    if (due.getTime() >= minute) continue;
    return minute - due.getTime() <= windowMs ? `nightly:${zonedDateKey(due, tz)}` : null;
  }
  return null;
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
      ...(item.outcome === "skipped" && item.expected ? { expected: true } : {}),
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
        }
      }
    }
    out.push(row);
  }

  const rank = (r: BackupSummaryRow) =>
    r.outcome === "failed" ? 0 : r.shrunk ? 1 : (r.outcome === "skipped" && !r.expected) ? 2 : OUTCOME_ORDER[r.outcome];
  return out.sort(
    (a, b) => rank(a) - rank(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.appName.localeCompare(b.appName) || a.volumeName.localeCompare(b.volumeName),
  );
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

/** A row a person should look at: failed, skipped unexpectedly, or much smaller than usual. */
export function isProblemRow(row: BackupSummaryRow): boolean {
  return row.outcome === "failed" || (row.outcome === "skipped" && !row.expected) || Boolean(row.shrunk);
}

/** Whether the summary has something that needs a person: a problem row, a stale volume or a job that never finished. */
export function needsAttention(rows: BackupSummaryRow[], staleVolumes: number, unfinished = 0): boolean {
  return staleVolumes > 0 || unfinished > 0 || rows.some(isProblemRow);
}

/** Run keys of runs someone started by hand. */
export const MANUAL_RUN_PREFIX = "manual:";

/** A manual job or a restore always reports; a scheduled run emails only when something needs a look, unless the org opted in. */
export function summaryEmails(
  run: { kind: string; runKey: string },
  rows: BackupSummaryRow[],
  staleVolumes: number,
  unfinished: number,
  alwaysSummary: boolean,
): { send: boolean; problemsOnly: boolean } {
  const scheduled = run.kind === "nightly" || (run.kind === "job" && !run.runKey.startsWith(MANUAL_RUN_PREFIX));
  if (!scheduled || alwaysSummary) return { send: true, problemsOnly: false };
  return { send: needsAttention(rows, staleVolumes, unfinished), problemsOnly: true };
}
