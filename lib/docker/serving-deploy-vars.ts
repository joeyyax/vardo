// The deploy variables an app's serving deployment set, for the variables tab.

import { db } from "@/lib/db";
import { apps, deployments, environments } from "@/lib/db/schema";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";

type Row = { id: string; rollbackFromId: string | null; configSnapshot: ConfigSnapshot | null };

/** Injectable deployment lookups. */
export type ServingLoader = {
  app: (appId: string) => Promise<{ id: string; name: string; parentAppId: string | null; composeService: string | null } | null>;
  /** The owner app's environment row matching this app's environment, or its default when `environmentId` is null. */
  environment: (appId: string, ownerId: string, environmentId: string | null) => Promise<{ id: string; isDefault: boolean } | null>;
  latest: (ownerId: string, env: { id: string; isDefault: boolean } | null) => Promise<Row | null>;
  byId: (id: string) => Promise<Row | null>;
};

const columns = { id: true, rollbackFromId: true, configSnapshot: true } as const;

const defaultLoader: ServingLoader = {
  app: async (appId) =>
    (await db.query.apps.findFirst({
      where: eq(apps.id, appId),
      columns: { id: true, name: true, parentAppId: true, composeService: true },
    })) ?? null,
  environment: async (appId, ownerId, environmentId) => {
    if (!environmentId) {
      const row = await db.query.environments.findFirst({
        where: and(eq(environments.appId, ownerId), eq(environments.isDefault, true)),
        columns: { id: true, isDefault: true },
      });
      return row ? { id: row.id, isDefault: true } : null;
    }
    const own = await db.query.environments.findFirst({
      where: and(eq(environments.id, environmentId), eq(environments.appId, appId)),
      columns: { name: true },
    });
    if (!own) return null;
    // A child app's environments mirror its parent's by name; deploys belong to the parent.
    const row = await db.query.environments.findFirst({
      where: and(eq(environments.appId, ownerId), eq(environments.name, own.name)),
      columns: { id: true, isDefault: true },
    });
    return row ? { id: row.id, isDefault: row.isDefault ?? false } : null;
  },
  latest: async (ownerId, env) =>
    ((await db.query.deployments.findFirst({
      where: and(
        eq(deployments.appId, ownerId),
        eq(deployments.status, "success"),
        // Rows from before environments have none and belong to the default.
        ...(env ? [env.isDefault ? or(eq(deployments.environmentId, env.id), isNull(deployments.environmentId)) : eq(deployments.environmentId, env.id)] : []),
      ),
      orderBy: [desc(deployments.startedAt)],
      columns,
    })) as Row | undefined) ?? null,
  byId: async (id) => ((await db.query.deployments.findFirst({ where: eq(deployments.id, id), columns })) as Row | undefined) ?? null,
};

/** Hops from an instant rollback's row back to the deploy that built the slot it started. */
const MAX_HOPS = 5;

/** The serving deployment's variables for this app's service, or null before its first recorded deploy. */
export async function servingDeployVars(
  appId: string,
  environmentId: string | null,
  load: ServingLoader = defaultLoader,
): Promise<{ deploymentId: string; vars: Record<string, string> } | null> {
  const app = await load.app(appId);
  if (!app) return null;
  const ownerId = app.parentAppId ?? app.id;
  const env = await load.environment(app.id, ownerId, environmentId);
  if (environmentId && !env) return null;

  let row = await load.latest(ownerId, env);
  // An instant rollback restarts the standby as it was; its own row records no variables.
  for (let hop = 0; row && !row.configSnapshot?.deployVars && row.rollbackFromId && hop < MAX_HOPS; hop++) {
    row = await load.byId(row.rollbackFromId);
  }
  const byService = row?.configSnapshot?.deployVars;
  if (!row || !byService) return null;

  const services = Object.keys(byService);
  const service = app.parentAppId
    ? app.composeService
    : (services.find((s) => byService[s].VARDO_APP_NAME === app.name) ?? services[0]);
  const vars = service ? byService[service] : undefined;
  return vars ? { deploymentId: row.id, vars } : null;
}
