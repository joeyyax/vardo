// ---------------------------------------------------------------------------
// Durable stability history
//
// The half of the stability view that survives a deploy. Docker's restart
// counter dies with the container it belongs to; these rows do not, because
// they were written when the crash happened rather than counted afterwards.
// ---------------------------------------------------------------------------

import { and, desc, eq, gte, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { activities, deployments } from "@/lib/db/schema";
import { buildIncidents, STABILITY_ACTIONS, type Incident } from "@/lib/ui/stability";

/** How far back the timeline reaches. Two trend windows, plus room to read one. */
export const HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

const ROW_LIMIT = 200;

/** Container faults and release faults for one app, newest first. */
export async function loadStabilityHistory(appId: string, now = new Date()): Promise<Incident[]> {
  const since = new Date(now.getTime() - HISTORY_MS);

  const [activityRows, deployRows] = await Promise.all([
    db.query.activities.findMany({
      where: and(
        eq(activities.appId, appId),
        gte(activities.createdAt, since),
        inArray(activities.action, [...STABILITY_ACTIONS]),
      ),
      orderBy: [desc(activities.createdAt)],
      columns: { action: true, createdAt: true, metadata: true },
      limit: ROW_LIMIT,
    }),
    db.query.deployments.findMany({
      where: and(eq(deployments.appId, appId), gte(deployments.startedAt, since)),
      orderBy: [desc(deployments.startedAt)],
      columns: { status: true, postDeployError: true, startedAt: true, finishedAt: true },
      limit: ROW_LIMIT,
    }),
  ]);

  return buildIncidents(activityRows, deployRows);
}
