// When a backup batch sends and what its summary says. No I/O.

import type { BackupSummaryRow } from "@/lib/bus/events";
import { backupDrop } from "@/lib/email/templates/visuals";

export type BackupBatchKind = "backup" | "drill" | "restore" | "import";

export type BackupBatchItem = {
  kind: BackupBatchKind;
  appId: string | null;
  appName: string | null;
  volumeName: string;
  jobName?: string | null;
  outcome: "success" | "failed" | "skipped";
  sizeBytes?: number;
  durationMs?: number;
  error?: string;
  backupId?: string;
  /** ISO time the result came in. */
  at: string;
};

/** A failure sends within this long of landing. */
export const FAILURE_FLUSH_MS = 5 * 60_000;

/** Rows past this are counted, not listed. */
export const MAX_SUMMARY_ROWS = 60;

/** The latest a batch sends: the window after its first result, sooner after a failure. */
export function flushDeadline(openedAt: number, windowMs: number, failureAt: number | null): number {
  const deadline = openedAt + windowMs;
  return failureAt === null ? deadline : Math.min(deadline, failureAt + FAILURE_FLUSH_MS);
}

/** Whether a result starts a batch. A passing drill only rides along with one already open. */
export function opensBatch(item: Pick<BackupBatchItem, "kind" | "outcome">): boolean {
  return !(item.kind === "drill" && item.outcome === "success");
}

/** Sends at the deadline, or once nothing is running and nothing else is due before it. */
export function shouldFlush(
  flushAt: number,
  now: number,
  activity: { running: boolean; nextScheduledAt: number | null },
): boolean {
  if (now >= flushAt) return true;
  if (activity.running) return false;
  return activity.nextScheduledAt === null || activity.nextScheduledAt > flushAt;
}

const KIND_ORDER: Record<BackupBatchKind, number> = { backup: 0, restore: 1, import: 2, drill: 3 };
const OUTCOME_ORDER = { failed: 0, skipped: 2, success: 3 } as const;

/** `appId:volume`, the key backup history is looked up by. */
export function volumeKey(appId: string | null, volumeName: string): string {
  return `${appId ?? ""}:${volumeName}`;
}

/**
 * One row per kind, app and volume, the latest result winning. Failures first, then
 * backups that shrank, then the rest by app.
 */
export function summarizeBatch(items: BackupBatchItem[], history: Map<string, number[]>): BackupSummaryRow[] {
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

/** Whether the summary has something that needs a person: a failure, a shrink or a stale volume. */
export function needsAttention(rows: BackupSummaryRow[], staleVolumes: number): boolean {
  return staleVolumes > 0 || rows.some((r) => r.outcome === "failed" || r.shrunk);
}
