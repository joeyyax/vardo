import { and, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { activityConditions, activityFacets, countActivities } from "@/lib/activity/query";
import type { ActivityFilters, ActivityRow } from "@/lib/activity/types";
import { authorize, requireFeature, type Actor } from "./actor";

export const ACTIVITY_PAGE_SIZE = 50;

/** A page of the org's activity, newest first, and the total matching the filters. */
export async function listActivities(
  actor: Actor,
  opts: { filters: ActivityFilters; appId?: string | null; limit?: number; offset?: number },
): Promise<{ activities: ActivityRow[]; total: number }> {
  authorize(actor, "org.view");
  await requireFeature("activity");
  const scope = { orgId: actor.org.id, appId: opts.appId };
  const [rows, total] = await Promise.all([
    db.query.activities.findMany({
      where: and(...activityConditions(scope, opts.filters)),
      columns: { id: true, action: true, family: true, outcome: true, metadata: true, createdAt: true },
      with: {
        user: { columns: { id: true, name: true, email: true, image: true } },
        app: { columns: { id: true, name: true, displayName: true } },
      },
      orderBy: [desc(activities.createdAt)],
      limit: opts.limit ?? ACTIVITY_PAGE_SIZE,
      offset: opts.offset ?? 0,
    }),
    countActivities(scope, opts.filters),
  ]);
  return { activities: rows, total };
}

/** The activity page's first rows and its filter bar counts. */
export async function loadActivityPage(actor: Actor, filters: ActivityFilters) {
  const [page, facets] = await Promise.all([
    listActivities(actor, { filters }),
    activityFacets({ orgId: actor.org.id }, filters.since),
  ]);
  return { rows: page.activities, total: page.total, facets };
}
