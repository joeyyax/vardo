import { db } from "@/lib/db";
import { apps, environments, environmentEnv } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { snapshotEnv } from "@/lib/env/environment-env";

/** An environment's own encrypted env, or null when it has none. */
export async function loadEnvironmentEnv(environmentId: string): Promise<string | null> {
  const row = await db.query.environmentEnv.findFirst({
    where: eq(environmentEnv.environmentId, environmentId),
  });
  return row?.envContent ?? null;
}

/** The encrypted env of an app's environment by name, or null when either is missing. */
export async function environmentEnvContent(appId: string, environmentName: string): Promise<string | null> {
  const env = await db.query.environments.findFirst({
    where: and(eq(environments.appId, appId), eq(environments.name, environmentName)),
    columns: { id: true },
  });
  return env ? loadEnvironmentEnv(env.id) : null;
}

/**
 * Give a new environment of a standalone app its own env: the source
 * environment's when it has one, otherwise the app's, with production
 * hostnames rewritten to `domain`.
 */
export async function snapshotIntoEnvironment(opts: {
  appId: string;
  organizationId: string;
  environmentId: string;
  domain?: string | null;
  sourceEnvironmentId?: string | null;
}): Promise<number> {
  const app = await db.query.apps.findFirst({
    where: and(eq(apps.id, opts.appId), eq(apps.organizationId, opts.organizationId)),
    columns: { envContent: true, cloneStrategy: true },
    with: { domains: { columns: { domain: true } } },
  });
  if (!app) return 0;
  const sourceEnv = opts.sourceEnvironmentId
    ? await db.query.environments.findFirst({
        where: and(eq(environments.id, opts.sourceEnvironmentId), eq(environments.appId, opts.appId)),
        columns: { id: true },
      })
    : undefined;
  const source = sourceEnv ? await loadEnvironmentEnv(sourceEnv.id) : null;
  const hostReplacements = new Map<string, string>();
  if (opts.domain) for (const d of app.domains) hostReplacements.set(d.domain, opts.domain);
  const snapshot = snapshotEnv({
    appEnvContent: source ?? app.envContent,
    organizationId: opts.organizationId,
    hostReplacements,
    strategy: app.cloneStrategy,
  });
  await saveEnvironmentEnv(opts.environmentId, snapshot.envContent);
  return snapshot.varCount;
}

/** Store an environment's env, replacing any it had. */
export async function saveEnvironmentEnv(environmentId: string, envContent: string): Promise<void> {
  await db
    .insert(environmentEnv)
    .values({ environmentId, envContent })
    .onConflictDoUpdate({
      target: environmentEnv.environmentId,
      set: { envContent, updatedAt: new Date() },
    });
}
