import type { BusEvent } from "@/lib/bus/events";
import type { RunProgress } from "./types";

/** Live runs keyed by job id. */
export type ProgressByJob = Record<string, RunProgress>;

/**
 * Fold a bus event into the in-flight run map: progress advances a job,
 * a terminal backup event clears it. Returns the same object when nothing
 * changed so React can skip the render.
 */
export function applyBackupEvent(current: ProgressByJob, event: BusEvent): ProgressByJob {
  if (event.type === "backup.progress") {
    return {
      ...current,
      [event.jobId]: {
        jobId: event.jobId,
        appName: event.appName,
        volumeName: event.volumeName,
        index: event.index,
        total: event.total,
      },
    };
  }

  if (event.type === "backup.success" || event.type === "backup.failed") {
    if (!current[event.jobId]) return current;
    const next = { ...current };
    delete next[event.jobId];
    return next;
  }

  return current;
}
