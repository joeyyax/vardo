import type { AttentionRow } from "@/lib/ui/attention";
import { BACKUP_TITLE } from "@/lib/ui/conditions";

export type CoverageApp = {
  id: string;
  name: string;
  displayName: string | null;
  status: "uncovered" | "partial";
  volumeCount: number;
};

/** Vardo's own database job: absent, switched off, or running on time. Null when the viewer can't act on it. */
export type SystemJobState =
  | { kind: "missing" }
  | { kind: "disabled" }
  | { kind: "overdue"; since: Date; neverRan: boolean }
  | { kind: "ok" }
  | null;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** What nothing is backing up, said where people look, not only when they deploy. */
export function backupCoverageRows(input: {
  hasTarget: boolean;
  uncovered: CoverageApp[];
  systemJob: SystemJobState;
}): AttentionRow[] {
  const rows: AttentionRow[] = [];

  if (!input.hasTarget) {
    rows.push({
      key: "backup-no-target",
      label: "No backup target",
      tone: "warning",
      group: "backups",
      items: [
        {
          id: "backup-no-target",
          name: "Backup storage",
          href: "/backups",
          detail: "Nothing is backed up until storage is added",
          fix: { label: "Add storage", href: "/backups" },
        },
      ],
      footer: "Nothing is backed up until storage is added, including Vardo's own database.",
    });
  }

  if (input.uncovered.length > 0) {
    rows.push({
      key: "backup-uncovered",
      label: BACKUP_TITLE.uncovered,
      tone: "warning",
      group: "backups",
      items: input.uncovered.map((a) => ({
        id: `backup-uncovered-${a.id}`,
        subject: a.id,
        name: a.displayName ?? a.name,
        href: `/apps/${a.name}/backups`,
        detail: a.status === "partial" ? "Some volumes left out" : plural(a.volumeCount, "volume"),
        fix: { label: "Choose what to back up", href: "/backups" },
      })),
      footer: `${plural(input.uncovered.length, "app")} with data no backup job captures.`,
      action: { label: "Choose what to back up", href: "/backups" },
    });
  }

  const job = input.systemJob;
  if (input.hasTarget && job && job.kind !== "ok") {
    rows.push({
      key: "backup-system-db",
      label: "Vardo database",
      tone: "error",
      group: "backups",
      items: [
        {
          id: "backup-system-db",
          name: "Vardo database",
          href: "/admin/settings/backup",
          title:
            job.kind === "missing"
              ? BACKUP_TITLE.uncovered
              : job.kind === "disabled"
                ? BACKUP_TITLE.paused
                : job.neverRan
                  ? BACKUP_TITLE.never
                  : BACKUP_TITLE.overdue,
          detail: job.kind === "disabled" ? "Backup job is switched off" : "Holds every app definition, variable and domain",
          since: job.kind === "overdue" ? job.since.toISOString() : undefined,
        },
      ],
      footer: "It holds every app definition, variable and domain.",
    });
  }

  return rows;
}
