import "server-only";

import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { VARDO_SELF_APP_NAME } from "@/lib/api/system-managed";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { CORE_SERVICE_FEATURES, CORE_SERVICE_NAMES, isCoreServiceApp } from "@/lib/infra/core-services";
import { isInstanceInfraApp } from "@/lib/infra/instance-apps";
import { getServicesDown } from "./fleet";
import type { InfrastructureSnapshot } from "./infrastructure-rows";

const RUNNING_DEPLOYMENT_STATUSES = ["queued", "running"] as const;

/** Core service parents, for pulling their compose children into the snapshot. */
const coreParents = alias(apps, "core_parents");

/**
 * State of Vardo's own stack and the shared core services. Never filtered by
 * organization: the caller's scope has no bearing on whether the console is
 * restarting.
 *
 * Compose children are included: a stack whose database container is down reads
 * "active" on the parent row, so the child is the only place the outage shows.
 */
export async function getInfrastructureSnapshot(now = new Date()): Promise<InfrastructureSnapshot> {
  const rows = await db
    .select({
      id: apps.id,
      name: apps.name,
      displayName: apps.displayName,
      status: apps.status,
      parentAppId: apps.parentAppId,
      conditions: apps.conditions,
    })
    .from(apps)
    .where(
      or(
        eq(apps.name, VARDO_SELF_APP_NAME),
        like(apps.name, `${VARDO_SELF_APP_NAME}-%`),
        inArray(apps.name, CORE_SERVICE_NAMES),
        inArray(
          apps.parentAppId,
          db
            .select({ id: coreParents.id })
            .from(coreParents)
            .where(inArray(coreParents.name, CORE_SERVICE_NAMES)),
        ),
      ),
    );

  // Children carry no instance-infra prefix in their names, so they are kept by
  // parent instead.
  const coreParentIds = new Set(
    rows.filter((a) => !a.parentAppId && isCoreServiceApp(a.name)).map((a) => a.id),
  );
  const infraApps = rows.filter(
    (app) =>
      isInstanceInfraApp(app.name) || (!!app.parentAppId && coreParentIds.has(app.parentAppId)),
  );

  const appIds = infraApps.map((a) => a.id);

  const [running, servicesDown, disabledCoreServices] = await Promise.all([
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
    disabledCoreServiceNames(),
  ]);

  return { apps: infraApps, deployments: running, servicesDown, disabledCoreServices };
}

/** Services belonging to a feature that is turned off. Nothing expects them up. */
async function disabledCoreServiceNames(): Promise<string[]> {
  const enabled = await Promise.all(
    CORE_SERVICE_FEATURES.map((f) => isFeatureEnabledAsync(f.flag)),
  );
  return CORE_SERVICE_FEATURES.flatMap((f, i) =>
    enabled[i] ? [] : f.services.map((s) => s.name),
  );
}
