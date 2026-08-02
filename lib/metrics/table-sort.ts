/** Sorting for the per-app metrics table. */

export type AppSortKey = "name" | "cpu" | "memory" | "network" | "limit" | "containers";
export type SortDirection = "asc" | "desc";

export type SortableAppRow = {
  name: string;
  cpu: number;
  memory: number;
  network: number;
  limit: number;
  containers: number;
};

export const DEFAULT_SORT: { key: AppSortKey; direction: SortDirection } = {
  key: "cpu",
  direction: "desc",
};

/** Numeric columns break ties by name so equal rows hold a stable order. */
export function compareAppRows(
  a: SortableAppRow,
  b: SortableAppRow,
  key: AppSortKey,
  direction: SortDirection,
): number {
  const sign = direction === "asc" ? 1 : -1;
  if (key === "name") return sign * a.name.localeCompare(b.name);
  const diff = a[key] - b[key];
  return diff !== 0 ? sign * diff : a.name.localeCompare(b.name);
}

export function sortAppRows<T extends SortableAppRow>(
  rows: T[],
  key: AppSortKey,
  direction: SortDirection,
): T[] {
  return [...rows].sort((a, b) => compareAppRows(a, b, key, direction));
}

/** Clicking the active column flips it; a new column starts descending, except names. */
export function nextSortDirection(
  current: { key: AppSortKey; direction: SortDirection },
  key: AppSortKey,
): SortDirection {
  if (current.key === key) return current.direction === "asc" ? "desc" : "asc";
  return key === "name" ? "asc" : "desc";
}
