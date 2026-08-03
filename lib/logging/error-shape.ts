// ---------------------------------------------------------------------------
// The line shape an error rate is counted from.
//
// A handful of tokens every runtime spells the same way, so nothing has to know
// what language a container is written in. `error` and `exception` also match as
// suffixes, which is what catches NullPointerException and ValueError.
//
// Precision is not the goal and cannot be: a node_modules path containing
// `request-error` matches, and so does a structured `error=""` field on an INFO
// line. What matters is that the same line matches every time, so a constant
// false-positive floor settles into the app's own baseline instead of moving it.
// ---------------------------------------------------------------------------

/** Go RE2, Loki's engine — no lookaround, no backreferences. */
export const ERROR_SHAPE = "(?i)\\b(fatal|panic|critical|traceback)\\b|[a-z]*(error|exception)\\b";

/** Streams carrying a Vardo app id. Containers Vardo does not manage are not counted. */
const MANAGED = '{project_id=~".+"}';

/** Labels the counts are grouped by — an app id, and the service inside its stack. */
const COUNT_GROUPING = "project_id, service";

/**
 * Lines matching the error shape per app and service, over the last `seconds`.
 * One instant query covers the whole fleet.
 */
export function errorCountQuery(seconds: number): string {
  return `sum by (${COUNT_GROUPING}) (count_over_time(${MANAGED} |~ \`${ERROR_SHAPE}\` [${seconds}s]))`;
}

/** Every line per app and service, over the same window — the denominator. */
export function lineCountQuery(seconds: number): string {
  return `sum by (${COUNT_GROUPING}) (count_over_time(${MANAGED} [${seconds}s]))`;
}

export type CountedSeries = { labels: Record<string, string>; value: number };
export type CountedApp = { id: string; parentAppId: string | null; composeService: string | null };

/**
 * Counts per app id. Promtail labels a stack's streams with the parent's app id,
 * so a series lands on the child that owns the service and on the parent, whose
 * number is the whole stack.
 */
export function attributeCounts(series: CountedSeries[], apps: CountedApp[]): Map<string, number> {
  const children = new Map<string, string>();
  for (const app of apps) {
    if (app.parentAppId && app.composeService) {
      children.set(`${app.parentAppId} ${app.composeService}`, app.id);
    }
  }

  const counts = new Map<string, number>();
  const add = (id: string, value: number) => counts.set(id, (counts.get(id) ?? 0) + value);

  for (const entry of series) {
    const owner = entry.labels.project_id;
    if (!owner || !Number.isFinite(entry.value)) continue;
    add(owner, entry.value);

    const child = children.get(`${owner} ${entry.labels.service ?? ""}`);
    if (child) add(child, entry.value);
  }

  return counts;
}
