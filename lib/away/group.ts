// ---------------------------------------------------------------------------
// Collapse notable items that say the same thing about different subjects.
//
// A fleet-wide event produces one item per app. Ninety-two rows reading
// "App is down · Nothing explains it" carry the information of one row and
// bury everything that is genuinely different underneath them.
// ---------------------------------------------------------------------------

/** The fields a row renders. Kept structural so the wire and domain types both fit. */
export type GroupableItem = {
  id: string;
  kind: string;
  reason: string;
  subjectName: string;
  detail?: string;
  href?: string;
  count: number;
};

export type AwayGroup<T extends GroupableItem> = {
  /** Key the group formed on. */
  key: string;
  /** Members in input order. Always at least one. */
  items: T[];
  /** Shared by every member. */
  kind: string;
  reason: string;
  detail?: string;
  /** Total occurrences, not subjects — a subject can have fired several times. */
  occurrences: number;
};

/** Items only group when the whole sentence they render would be identical. */
function groupKey(item: GroupableItem): string {
  return `${item.kind}|${item.reason}|${item.detail ?? ""}`;
}

/**
 * Group by rendered sentence, preserving first-seen order so severity ordering
 * from the classifier survives.
 */
export function groupNotable<T extends GroupableItem>(items: T[]): AwayGroup<T>[] {
  const groups = new Map<string, AwayGroup<T>>();

  for (const item of items) {
    const key = groupKey(item);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      existing.occurrences += item.count;
      continue;
    }
    groups.set(key, {
      key,
      items: [item],
      kind: item.kind,
      reason: item.reason,
      detail: item.detail,
      occurrences: item.count,
    });
  }

  return [...groups.values()];
}

/**
 * "agents", "agents and authentik", "agents, authentik and 90 more".
 * Two names read better joined than truncated, so the cutoff starts at three.
 */
export function subjectSummary(names: string[], max = 2): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length <= max + 1) {
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}
