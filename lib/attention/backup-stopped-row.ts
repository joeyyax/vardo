import { appNotRunning, type AppRunState } from "@/lib/apps/run-state";
import { stoppedBackupLabel } from "@/lib/backups/staleness";
import type { AttentionItem, AttentionRow } from "@/lib/ui/attention";

/** A job on hold: past due, or waiting on a dump, because its apps were stopped on purpose. */
export type HeldBackupJob = {
  job: { id: string; name: string };
  lastBackupAt: Date | null;
  apps: { id: string; name: string; displayName: string }[];
};

type DumpRow = AppRunState & { id: string; name: string; displayName: string; jobId: string; jobName: string; lastRunAt: Date | null };

/** Down apps with a dump: on hold when stopped on purpose, once per job; paused otherwise, once per app. */
export function splitPausedDumps<T extends DumpRow>(rows: T[]): { paused: T[]; onHold: HeldBackupJob[] } {
  const paused = new Map<string, T>();
  const onHold = new Map<string, HeldBackupJob>();
  for (const row of rows) {
    if (appNotRunning(row)) {
      onHold.set(`${row.jobId}:${row.id}`, { job: { id: row.jobId, name: row.jobName }, lastBackupAt: row.lastRunAt, apps: [{ id: row.id, name: row.name, displayName: row.displayName }] });
    } else if (!paused.has(row.id)) {
      paused.set(row.id, row);
    }
  }
  return { paused: [...paused.values()], onHold: [...onHold.values()] };
}

/** Jobs held only because their apps were stopped on purpose, each app once per job. Informational. */
export function stoppedBackupRow(jobs: HeldBackupJob[], timeZone: string): AttentionRow | null {
  const items = new Map<string, AttentionItem>();
  for (const o of jobs) {
    const detail = stoppedBackupLabel(o.lastBackupAt, timeZone);
    if (o.apps.length === 0) items.set(o.job.id, { id: o.job.id, name: o.job.name, href: "/backups", detail });
    for (const app of o.apps) {
      const id = `${o.job.id}:${app.id}`;
      items.set(id, { id, subject: app.id, name: app.displayName, href: `/apps/${app.name}/backups`, detail });
    }
  }
  if (items.size === 0) return null;
  return {
    key: "backup-app-stopped",
    label: "Backups on hold",
    tone: "neutral",
    items: [...items.values()],
    footer: "Stopped on purpose. Backups pick up when the app starts.",
  };
}
