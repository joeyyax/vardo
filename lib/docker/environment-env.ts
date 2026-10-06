import { db } from "@/lib/db";
import { environments, environmentEnv } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

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
