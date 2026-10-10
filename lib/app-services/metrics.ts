import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { authorize, type Actor } from "./actor";

/** The metrics page: off when the feature is, else every app with its reconciled status. Live figures stream from the stats API. */
export async function loadMetricsPage(actor: Actor) {
  if (!(await isFeatureEnabledAsync("metrics"))) return { enabled: false as const, apps: [] };
  authorize(actor, "org.view");
  const appList = await db.query.apps.findMany({
    where: eq(apps.organizationId, actor.org.id),
    orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
    columns: { id: true, name: true, displayName: true, status: true, parentAppId: true },
  });
  return { enabled: true as const, apps: appList };
}
