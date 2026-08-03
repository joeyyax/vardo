import type { AppCondition } from "@/lib/docker/conditions";
import { conditionKindLabel } from "@/lib/ui/conditions";

/** "activity" is routine — something running right now, not a problem. */
export type AttentionTone = "error" | "warning" | "neutral" | "activity";

export type AttentionItem = {
  id: string;
  name: string;
  /** Omitted when the viewer has no route to the subject — the line still renders. */
  href?: string;
  /** What is wrong with this subject. */
  detail?: string;
  /** ISO timestamp of first confirmation, rendered as "for 5 hours". */
  since?: string;
  /** Opens in a new tab — release notes and other off-instance links. */
  external?: boolean;
};

/** Serializable: rows cross the API boundary, so no ReactNode in here. */
export type AttentionRow = {
  key: string;
  label: string;
  tone: AttentionTone;
  items: AttentionItem[];
  /** Sentence under the subjects — what to do about it. */
  footer?: string;
  /** Link beside the footer, for a page that handles the whole row at once. */
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

/**
 * Instance rows first, then org rows with any subject the instance already
 * reported removed. The two sources are built not to overlap; this is the
 * guarantee that a change to either one cannot start showing an event twice.
 */
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

/** One sentence per row for a screen reader, or empty when there is nothing to say. */
export function announceAttention(rows: AttentionRow[]): string {
  return presentRows(rows)
    .map((row) => {
      const names = row.items.map((i) => i.name).join(", ");
      return names ? `${row.label}: ${names}.` : `${row.label}.`;
    })
    .join(" ");
}

/** Only error and warning rows are faults — neutral facts and activity are listed but not counted. */
export function faultCount(rows: AttentionRow[]): number {
  return rows
    .filter((r) => r.tone === "error" || r.tone === "warning")
    .reduce((n, r) => n + r.items.length, 0);
}

/** Faults this few are named in the collapsed bar rather than hidden behind it. */
export const BAR_SUBJECT_LIMIT = 2;

export type BarSummary = {
  rows: AttentionRow[];
  faults: number;
  worst: AttentionTone | null;
  /** Named outright when there are few enough to fit; otherwise counted by kind. */
  subjects: AttentionItem[];
  kinds: { key: string; label: string; tone: AttentionTone; count: number }[];
};

/**
 * What the one-line bar says before anyone clicks it. A single fault reads as
 * itself — expanding to find one chip is the failure this replaces.
 */
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

/** Rows this short list their subjects outright; longer ones collapse. */
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

/** One row per condition kind across the fleet, worst severity setting the tone. */
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
        href: `/apps/${app.name}`,
        detail: condition.detail,
        since: condition.since,
      });
      byKind.set(condition.kind, row);
    }
  }

  return [...byKind.values()];
}
