// Backup runs: when they start, how long they should take, when they're done and what the summary says. No I/O.

import type { BackupSummaryRow } from "@/lib/bus/events";
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
  jobs: { jobId: string; jobName: string }[];
  apps: { appId: string | null; appName: string; volumes: string[] }[];
  /** "R2 · vardo-backups/node-a", no credentials. */
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

/**
 * Expected run time from each volume's recent backups: their sum spread over the concurrency, never
 * shorter than the slowest one. Null without any history.
 */
export function estimateRunMs(volumeDurations: number[], concurrency: number): number | null {
  if (volumeDurations.length === 0) return null;
  const total = volumeDurations.reduce((a, b) => a + b, 0);
  return Math.round(Math.max(total / Math.max(1, concurrency), ...volumeDurations));
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
        if (row.outcome === "success") row.shrunk = backupDrop(past, row.sizeBytes) ?? undefined;
      }
    }
    out.push(row);
  }

  const rank = (r: BackupSummaryRow) => (r.outcome === "failed" ? 0 : r.shrunk ? 1 : OUTCOME_ORDER[r.outcome]);
  return out.sort(
    (a, b) => rank(a) - rank(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.appName.localeCompare(b.appName) || a.volumeName.localeCompare(b.volumeName),
  );
}

/** Whether the summary has something that needs a person: a failure, a shrink, a stale volume or a job that never finished. */
export function needsAttention(rows: BackupSummaryRow[], staleVolumes: number, unfinished = 0): boolean {
  return staleVolumes > 0 || unfinished > 0 || rows.some((r) => r.outcome === "failed" || r.shrunk);
}
