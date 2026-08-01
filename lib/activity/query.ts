// ---------------------------------------------------------------------------
// Activity view — database queries
//
// Server-only. Family and outcome are columns, so every filter is a predicate
// the database can answer and the feed reads one page rather than a scan.
// ---------------------------------------------------------------------------

import { and, count, eq, gte, inArray, isNotNull, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";

import type {
  ActivityFacets,
  ActivityFamily,
  ActivityFilters,
  ActivityOutcome,
} from "./types";

export type ActivityScope = {
  orgId: string;
  appId?: string | null;
};

/** Everything a facet count and a row page have in common. */
function scopeConditions(scope: ActivityScope, since: Date | null): SQL[] {
  const conditions: SQL[] = [eq(activities.organizationId, scope.orgId)];
  if (scope.appId) conditions.push(eq(activities.appId, scope.appId));
  if (since) conditions.push(gte(activities.createdAt, since));
  return conditions;
}

/** An empty family or outcome list means no restriction, not "match nothing". */
export function activityConditions(
  scope: ActivityScope,
  filters: ActivityFilters
): SQL[] {
  const conditions = scopeConditions(scope, filters.since);
  if (filters.families.length) {
    conditions.push(inArray(activities.family, filters.families));
  }
  if (filters.outcomes.length) {
    conditions.push(inArray(activities.outcome, filters.outcomes));
  }
  return conditions;
}

/**
 * Counts for the filter bar. Deliberately ignores the family and outcome chips
 * so selecting one never hides the others.
 */
export async function activityFacets(
  scope: ActivityScope,
  since: Date | null
): Promise<ActivityFacets> {
  const rows = await db
    .select({
      family: activities.family,
      outcome: activities.outcome,
      total: count(),
    })
    .from(activities)
    .where(
      and(
        ...scopeConditions(scope, since),
        isNotNull(activities.family),
        isNotNull(activities.outcome)
      )
    )
    .groupBy(activities.family, activities.outcome);

  const families = new Set<ActivityFamily>();
  const outcomes: Record<ActivityOutcome, number> = {
    success: 0,
    failure: 0,
    neutral: 0,
  };

  for (const row of rows) {
    if (row.family) families.add(row.family);
    if (row.outcome) outcomes[row.outcome] += row.total;
  }

  return { families: [...families], outcomes };
}

export async function countActivities(
  scope: ActivityScope,
  filters: ActivityFilters
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(activities)
    .where(and(...activityConditions(scope, filters)));
  return row?.total ?? 0;
}
