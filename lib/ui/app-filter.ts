import type { AppCondition } from "@/lib/docker/conditions";

export type SortKey = "attention" | "name" | "deployed";

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "attention", label: "Attention" },
  { key: "name", label: "Name" },
  { key: "deployed", label: "Last deployed" },
];

export function isSortKey(value: string): value is SortKey {
  return SORT_OPTIONS.some((o) => o.key === value);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export type FilterableProject = {
  name: string;
  displayName: string;
};

export type FilterableApp = {
  name: string;
  displayName: string;
  domains: { domain: string }[];
  project: FilterableProject;
};

/** Every term has to match something, so "web prod" narrows rather than widens. */
function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesAll(haystack: string[], query: string): boolean {
  const t = terms(query);
  if (t.length === 0) return true;
  const text = haystack.join(" ").toLowerCase();
  return t.every((term) => text.includes(term));
}

export function matchesProject(project: FilterableProject, query: string): boolean {
  return matchesAll([project.name, project.displayName], query);
}

/**
 * An app matches on its own name, its domains, or its project's name — so a
 * project searched for by name keeps all of its apps rather than none.
 */
export function matchesApp(app: FilterableApp, query: string): boolean {
  return matchesAll(
    [app.name, app.displayName, app.project.name, app.project.displayName,
      ...app.domains.map((d) => d.domain)],
    query,
  );
}

export function filterApps<T extends FilterableApp>(apps: T[], query: string): T[] {
  if (terms(query).length === 0) return apps;
  return apps.filter((a) => matchesApp(a, query));
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SortableApp = {
  status: string;
  conditions?: AppCondition[] | null;
  deployments?: { startedAt: Date | string }[];
};

export type SortableCard<P extends { displayName: string } = { displayName: string }> = {
  project: P;
  apps: SortableApp[];
};

const ATTENTION_CRITICAL = 0;
const ATTENTION_WARNING = 1;
const ATTENTION_NONE = 2;

/**
 * Lower sorts first: crashes, then warnings, then everything quiet. A stopped
 * app is a deliberate state, not something to answer for.
 */
export function attentionRank(card: SortableCard): number {
  let rank = ATTENTION_NONE;
  for (const app of card.apps) {
    if (app.status === "error") return ATTENTION_CRITICAL;
    for (const condition of app.conditions ?? []) {
      if (condition.severity === "critical") return ATTENTION_CRITICAL;
      if (condition.severity === "warning") rank = ATTENTION_WARNING;
    }
    if (app.status === "missing") rank = ATTENTION_WARNING;
  }
  return rank;
}

/** Epoch ms of the most recent deployment across the card, or null. */
export function lastDeployedAt(card: SortableCard): number | null {
  let latest: number | null = null;
  for (const app of card.apps) {
    for (const d of app.deployments ?? []) {
      const ts = new Date(d.startedAt).getTime();
      if (!Number.isNaN(ts) && (latest === null || ts > latest)) latest = ts;
    }
  }
  return latest;
}

export function sortProjectCards<T extends SortableCard>(cards: T[], sort: SortKey): T[] {
  const byName = (a: T, b: T) => a.project.displayName.localeCompare(b.project.displayName);

  return [...cards].sort((a, b) => {
    if (sort === "name") return byName(a, b);
    if (sort === "deployed") {
      // Never deployed sorts last rather than as the oldest.
      const at = lastDeployedAt(a);
      const bt = lastDeployedAt(b);
      if (at === null && bt === null) return byName(a, b);
      if (at === null) return 1;
      if (bt === null) return -1;
      return bt - at || byName(a, b);
    }
    return attentionRank(a) - attentionRank(b) || byName(a, b);
  });
}
