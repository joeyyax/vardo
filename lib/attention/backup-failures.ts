// Which backup failures still stand. Pure; the read lives in ./rows.

import { REQUEUED_NOTE, SUPERSEDED_REASON } from "@/lib/backups/requeue-notes";

export type BackupOutcome = {
  id: string;
  appId: string | null;
  jobId: string | null;
  volumeName: string | null;
  status: string;
  startedAt: Date;
  log: string | null;
};

/** Notes the requeue sweep leaves on an interrupted row it reran, or found already rerun. */
const RERUN_NOTES = [REQUEUED_NOTE, SUPERSEDED_REASON];

/** Says nothing about whether the data is captured. */
const NOT_AN_OUTCOME = new Set(["skipped"]);

const rerun = (row: BackupOutcome) => !!row.log && RERUN_NOTES.some((note) => row.log!.includes(note));

/**
 * The most recent standing failure per app. A failure stands only while it is the latest outcome for its
 * app and volume: a later success, a run in progress or a requeue clears it.
 */
export function standingBackupFailures(rows: BackupOutcome[]): BackupOutcome[] {
  const latest = new Map<string, BackupOutcome>();
  for (const row of rows) {
    if (NOT_AN_OUTCOME.has(row.status)) continue;
    const owner = row.appId ?? `job:${row.jobId ?? row.id}`;
    const key = `${owner}:${row.volumeName ?? ""}`;
    const held = latest.get(key);
    if (!held || held.startedAt < row.startedAt) latest.set(key, row);
  }

  const byApp = new Map<string, BackupOutcome>();
  for (const row of latest.values()) {
    if (row.status !== "failed" || rerun(row) || !row.appId) continue;
    const held = byApp.get(row.appId);
    if (!held || held.startedAt < row.startedAt) byApp.set(row.appId, row);
  }
  return [...byApp.values()];
}
