import "server-only";

import { and, desc, eq, inArray, like, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { VARDO_SELF_APP_NAME } from "@/lib/api/system-managed";
import { CORE_SERVICE_NAMES } from "@/lib/infra/core-services";
import { isInstanceInfraApp } from "@/lib/infra/instance-apps";
import { getServicesDown } from "./fleet";
import type { InfrastructureSnapshot } from "./infrastructure-rows";

const RUNNING_DEPLOYMENT_STATUSES = ["queued", "running"] as const;

/**
 * State of Vardo's own stack and the shared core services. Never filtered by
 * organization: the caller's scope has no bearing on whether the console is
 * restarting.
 */
export async function getInfrastructureSnapshot(now = new Date()): Promise<InfrastructureSnapshot> {
  const infraApps = (
    await db
      .select({
        id: apps.id,
        name: apps.name,
        displayName: apps.displayName,
        status: apps.status,
        conditions: apps.conditions,
      })
      .from(apps)
      .where(
        or(
          eq(apps.name, VARDO_SELF_APP_NAME),
          like(apps.name, `${VARDO_SELF_APP_NAME}-%`),
          inArray(apps.name, CORE_SERVICE_NAMES),
        ),
      )
  ).filter((app) => isInstanceInfraApp(app.name));

  const appIds = infraApps.map((a) => a.id);

  const [running, servicesDown] = await Promise.all([
    appIds.length > 0
      ? db
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
          .orderBy(desc(deployments.startedAt))
      : [],
    getServicesDown(now),
  ]);

  return { apps: infraApps, deployments: running, servicesDown };
}
