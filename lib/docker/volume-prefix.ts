// `<app>-<env>` names an environment's volumes, networks and compose projects. Both parts may contain hyphens,
// so two pairs can yield one prefix (`foo` + `pr-12`, `foo-pr` + `12`). Existing prefixes never change; new
// collisions are refused here and by the `*_volume_prefix_guard` triggers.

import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, environments } from "@/lib/db/schema";

export function volumePrefix(appName: string, envName: string): string {
  return `${appName}-${envName}`;
}

/** The app that already owns this prefix, or null. `exceptEnvId` skips the environment being renamed. */
export async function findPrefixOwner(
  appName: string,
  envName: string,
  exceptEnvId?: string,
): Promise<string | null> {
  const prefix = volumePrefix(appName, envName);
  const [row] = await db
    .select({ app: apps.name, env: environments.name })
    .from(environments)
    .innerJoin(apps, eq(apps.id, environments.appId))
    .where(
      and(
        sql`${apps.name} || '-' || ${environments.name} = ${prefix}`,
        exceptEnvId ? ne(environments.id, exceptEnvId) : undefined,
      ),
    )
    .limit(1);
  return row ? `${row.app} (${row.env})` : null;
}

/** As `findPrefixOwner`, for an app that already exists. */
export async function findPrefixOwnerForApp(
  appId: string,
  envName: string,
  exceptEnvId?: string,
): Promise<string | null> {
  const app = await db.query.apps.findFirst({ where: eq(apps.id, appId), columns: { name: true } });
  return app ? findPrefixOwner(app.name, envName, exceptEnvId) : null;
}

export function prefixCollisionMessage(owner: string): string {
  return `This name would share volumes with ${owner}. Choose a different name.`;
}
