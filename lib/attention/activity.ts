import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { backups, deployments } from "@/lib/db/schema";
import type { FleetActivity } from "./activity-rows";

const RUNNING_DEPLOYMENT_STATUSES = ["queued", "running"] as const;

export type { FleetActivity } from "./activity-rows";
export { activityRows } from "./activity-rows";

/** Deploys and backups running right now, across this org's apps. */
export async function getFleetActivity(appIds: string[]): Promise<FleetActivity> {
  if (appIds.length === 0) return { deployments: [], backups: [] };

  const [activeDeployments, activeBackups] = await Promise.all([
    db
      .select({
        id: deployments.id,
        appId: deployments.appId,
        gitSha: deployments.gitSha,
        startedAt: deployments.startedAt,
      })
      .from(deployments)
      .where(
        and(
          inArray(deployments.appId, appIds),
          inArray(deployments.status, RUNNING_DEPLOYMENT_STATUSES),
        ),
      )
      .orderBy(desc(deployments.startedAt)),
    db
      .select({ id: backups.id, appId: backups.appId, startedAt: backups.startedAt })
      .from(backups)
      .where(and(eq(backups.status, "running"), inArray(backups.appId, appIds)))
      .orderBy(desc(backups.startedAt)),
  ]);

  return {
    deployments: activeDeployments,
    backups: activeBackups.filter((b) => b.appId !== null) as FleetActivity["backups"],
  };
}
