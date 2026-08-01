import type { ReactNode } from "react";

import type { AppCondition } from "@/lib/docker/conditions";
import { conditionKindLabel } from "@/lib/ui/conditions";

export type AttentionTone = "error" | "warning" | "neutral";

export type AttentionItem = {
  id: string;
  name: string;
  href: string;
  /** What is wrong with this subject. */
  detail?: string;
  /** ISO timestamp of first confirmation, rendered as "for 5 hours". */
  since?: string;
};

export type AttentionRow = {
  key: string;
  label: string;
  tone: AttentionTone;
  items: AttentionItem[];
  /** Sentence under the subjects — what to do about it. */
  footer?: ReactNode;
};

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
