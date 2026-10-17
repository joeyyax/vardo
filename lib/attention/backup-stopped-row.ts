import { stoppedBackupLabel, type StoppedBackupJob } from "@/lib/backups/staleness";
import type { AttentionRow } from "@/lib/ui/attention";

type StoppedJob = StoppedBackupJob & { apps: { id: string; name: string; displayName: string }[] };

/** Jobs behind schedule only because their apps were stopped on purpose. Informational. */
export function stoppedBackupRow(jobs: StoppedJob[], timeZone: string): AttentionRow | null {
  if (jobs.length === 0) return null;
  return {
    key: "backup-app-stopped",
    label: "Backups on hold",
    tone: "neutral",
    items: jobs.flatMap((o) => {
      const detail = stoppedBackupLabel(o.lastBackupAt, timeZone);
      if (o.apps.length === 0) return [{ id: o.job.id, name: o.job.name, href: "/backups", detail }];
      return o.apps.map((app) => ({
        id: `${o.job.id}:${app.id}`,
        subject: app.id,
        name: app.displayName,
        href: `/apps/${app.name}/backups`,
        detail,
      }));
    }),
    footer: "Stopped on purpose. Backups pick up when the app starts.",
  };
}
