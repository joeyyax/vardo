import type { AppCondition } from "@/lib/docker/conditions";
import type { ExitReason } from "@/lib/docker/exit-reason";
import { conditionHref, conditionKindLabel } from "@/lib/ui/conditions";
import { exitReasonShort } from "@/lib/ui/exit-reason";

/** "activity" is routine work in progress, not a problem. */
export type AttentionTone = "error" | "warning" | "neutral" | "activity";

export type AttentionItem = {
  id: string;
  name: string;
  /** Omitted when the viewer has no route to the subject. */
  href?: string;
  detail?: string;
  /** ISO timestamp of first confirmation, rendered as "for 5 hours". */
  since?: string;
  /** Opens in a new tab. */
  external?: boolean;
};

/** Serializable; rows cross the API boundary, so no ReactNode. */
export type AttentionRow = {
  key: string;
  label: string;
  tone: AttentionTone;
  items: AttentionItem[];
  /** What to do about it. */
  footer?: string;
  /** Link to a page that handles the whole row. */
  action?: { label: string; href: string };
};

const TONE_RANK: Record<AttentionTone, number> = { error: 0, warning: 1, neutral: 2, activity: 3 };

/** Non-empty rows, worst first, subjects alphabetical within each. */
export function presentRows(rows: AttentionRow[]): AttentionRow[] {
  return rows
    .filter((r) => r.items.length > 0)
    .map((r) => ({ ...r, items: [...r.items].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || a.label.localeCompare(b.label));
}

/** Instance rows, then org rows minus subjects the instance already reported. */
export function mergeAttentionRows(
  instanceRows: AttentionRow[],
  orgRows: AttentionRow[],
): AttentionRow[] {
  const claimed = new Set(instanceRows.flatMap((r) => r.items.map((i) => i.id)));
  const deduped = orgRows
    .map((row) => ({ ...row, items: row.items.filter((i) => !claimed.has(i.id)) }))
    .filter((row) => row.items.length > 0);
  return [...instanceRows, ...deduped];
}

/** One sentence per row for screen readers. */
export function announceAttention(rows: AttentionRow[]): string {
  return presentRows(rows)
    .map((row) => {
      const names = row.items.map((i) => i.name).join(", ");
      return names ? `${row.label}: ${names}.` : `${row.label}.`;
    })
    .join(" ");
}

/** Only error and warning rows count as faults. */
export function faultCount(rows: AttentionRow[]): number {
  return rows
    .filter((r) => r.tone === "error" || r.tone === "warning")
    .reduce((n, r) => n + r.items.length, 0);
}

/** Up to this many faults are named in the collapsed bar. */
export const BAR_SUBJECT_LIMIT = 2;

export type BarSummary = {
  rows: AttentionRow[];
  faults: number;
  worst: AttentionTone | null;
  /** Named when few enough to fit, otherwise counted by kind. */
  subjects: AttentionItem[];
  kinds: { key: string; label: string; tone: AttentionTone; count: number }[];
};

/** Collapsed bar summary. A single fault is named outright. */
export function summarize(rows: AttentionRow[]): BarSummary {
  const present = presentRows(rows);
  const faults = faultCount(present);
  const faultRows = present.filter((r) => r.tone === "error" || r.tone === "warning");

  return {
    rows: present,
    faults,
    worst: present[0]?.tone ?? null,
    subjects:
      faults > 0 && faults <= BAR_SUBJECT_LIMIT ? faultRows.flatMap((r) => r.items) : [],
    kinds: present.map((r) => ({
      key: r.key,
      label: r.label,
      tone: r.tone,
      count: r.items.length,
    })),
  };
}

/** Rows up to this length list their subjects; longer ones collapse. */
export const INLINE_SUBJECT_LIMIT = 5;

export function isInlineRow(row: AttentionRow): boolean {
  return row.items.length <= INLINE_SUBJECT_LIMIT;
}

type ConditionSubject = {
  id: string;
  name: string;
  displayName: string;
  conditions: AppCondition[] | null;
};

/** One row per condition kind across the fleet, toned by worst severity. */
export function conditionRows(apps: ConditionSubject[]): AttentionRow[] {
  const byKind = new Map<AppCondition["kind"], AttentionRow>();

  for (const app of apps) {
    for (const condition of app.conditions ?? []) {
      const row = byKind.get(condition.kind) ?? {
        key: condition.kind,
        label: conditionKindLabel(condition.kind),
        tone: "warning" as AttentionTone,
        items: [],
      };
      if (condition.severity === "critical") row.tone = "error";
      row.items.push({
        id: app.id,
        name: app.displayName,
        href: conditionHref(app.name, condition.kind),
        detail: condition.detail,
        since: condition.since,
      });
      byKind.set(condition.kind, row);
    }
  }

  return [...byKind.values()];
}

type ExitSubject = {
  id: string;
  name: string;
  displayName: string;
  exitReason: ExitReason | null;
};

/** Whether the host OOM killer hit any of these apps within the window. */
export function hadRecentHostOom(apps: ExitSubject[], now: number, windowMs: number): boolean {
  return apps.some(
    (a) => a.exitReason?.kind === "oom-host" && now - Date.parse(a.exitReason.at) <= windowMs,
  );
}

/** OOM-killed apps, split into host-capacity and cgroup-limit rows. Only Docker's OOMKilled counts, never exit 137. */
export function oomRows(apps: ExitSubject[], now: number, windowMs: number): AttentionRow[] {
  const host: AttentionItem[] = [];
  const limit: AttentionItem[] = [];

  for (const app of apps) {
    const reason = app.exitReason;
    if (!reason) continue;
    if (reason.kind !== "oom-host" && reason.kind !== "oom-limit") continue;
    if (now - Date.parse(reason.at) > windowMs) continue;

    (reason.kind === "oom-host" ? host : limit).push({
      id: app.id,
      name: app.displayName,
      href: `/apps/${app.name}`,
      detail: `${reason.containerName} · ${exitReasonShort(reason)}`,
      since: reason.at,
    });
  }

  const rows: AttentionRow[] = [];
  if (host.length > 0) {
    rows.push({
      key: "oom-host",
      label: "Killed for host memory",
      tone: "error",
      items: host,
      footer:
        "The host ran out and the kernel chose these. None of them has a memory limit, so nothing bounded what they took.",
      action: { label: "Review host memory", href: "/metrics" },
    });
  }
  if (limit.length > 0) {
    rows.push({
      key: "oom-limit",
      label: "Killed at memory limit",
      tone: "error",
      items: limit,
      footer: "These hit their own cgroup limit. Raise it, or find what is using more than it was given.",
    });
  }
  return rows;
}
