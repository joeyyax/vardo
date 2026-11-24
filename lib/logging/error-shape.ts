// The line shape an error rate is counted from: tokens every runtime spells the same way.
// Precision isn't the goal; a constant false-positive floor settles into the app's baseline.

import { FIELD, logsQLString } from "./victorialogs";

/** Go RE2, VictoriaLogs' engine — no lookaround, no backreferences. */
export const ERROR_SHAPE = "(?i)\\b(fatal|panic|critical|traceback)\\b|[a-z]*(error|exception)\\b";

/** Lines carrying a Vardo app id. Containers Vardo does not manage are not counted. */
const MANAGED = `${FIELD.projectId}:*`;

/** Fields the counts are grouped by — an app id, and the service inside its stack. */
const COUNT_GROUPING = `${FIELD.projectId}, ${FIELD.service}`;

/** Lines matching the error shape per app and service over the last `seconds`. */
export function errorCountQuery(seconds: number): string {
  return `_time:${seconds}s ${MANAGED} _msg:~${logsQLString(ERROR_SHAPE)} | stats by (${COUNT_GROUPING}) count() n`;
}

/** Every line per app and service, over the same window — the denominator. */
export function lineCountQuery(seconds: number): string {
  return `_time:${seconds}s ${MANAGED} | stats by (${COUNT_GROUPING}) count() n`;
}

export type CountedSeries = { labels: Record<string, string>; value: number };
export type CountedApp = { id: string; parentAppId: string | null; composeService: string | null };

/** Counts per app id. A stack's series land on both the child service and the parent. */
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
    const owner = entry.labels[FIELD.projectId];
    if (!owner || !Number.isFinite(entry.value)) continue;
    add(owner, entry.value);

    const child = children.get(`${owner} ${entry.labels[FIELD.service] ?? ""}`);
    if (child) add(child, entry.value);
  }

  return counts;
}
