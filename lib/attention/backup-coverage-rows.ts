import type { AttentionRow } from "@/lib/ui/attention";

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
      items: [{ id: "backup-no-target", name: "No backup target configured", href: "/backups" }],
      footer: "Nothing is backed up until storage is added, including Vardo's own database.",
    });
  }

  if (input.uncovered.length > 0) {
    rows.push({
      key: "backup-uncovered",
      label: "Not backed up",
      tone: "warning",
      items: input.uncovered.map((a) => ({
        id: `backup-uncovered-${a.id}`,
        name: a.displayName ?? a.name,
        href: `/apps/${a.name}/backups`,
        detail:
          a.status === "partial"
            ? "Some volumes left out"
            : `${plural(a.volumeCount, "volume")}, no backup job`,
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
      items: [
        {
          id: "backup-system-db",
          name: "Vardo database isn't being backed up",
          href: "/admin/settings/backup",
          detail:
            job.kind === "missing"
              ? "No backup job"
              : job.kind === "disabled"
                ? "Backup job is switched off"
                : job.neverRan
                  ? "Has never captured a backup"
                  : undefined,
          since: job.kind === "overdue" ? job.since.toISOString() : undefined,
        },
      ],
      footer: "It holds every app definition, variable and domain.",
    });
  }

  return rows;
}
