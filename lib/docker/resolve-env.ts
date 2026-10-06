import { db } from "@/lib/db";
import { environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { DeployBlockedError } from "./errors";

export type EnvType = "production" | "staging" | "preview" | "local";

export type ResolvedEnv = {
  name: string;
  type: EnvType;
  id: string | null;
};

export async function resolveDefaultEnv(appId: string): Promise<ResolvedEnv> {
  const env = await db.query.environments.findFirst({
    where: and(eq(environments.appId, appId), eq(environments.isDefault, true)),
    columns: { id: true, name: true, type: true },
  });

  return {
    name: env?.name ?? "production",
    type: env?.type ?? "production",
    id: env?.id ?? null,
  };
}

export type DeployEnv = {
  name: string;
  type: EnvType;
  gitBranch: string | null;
};

type DeployEnvRow = { name: string; type: EnvType; gitBranch: string | null };

/** Injectable loader — the real implementation reads the environments table. */
export type DeployEnvLoader = (
  appId: string,
  environmentId: string,
) => Promise<DeployEnvRow | null>;

const defaultLoader: DeployEnvLoader = async (appId, environmentId) => {
  const row = await db.query.environments.findFirst({
    where: and(eq(environments.id, environmentId), eq(environments.appId, appId)),
    columns: { name: true, type: true, gitBranch: true },
  });
  return row ?? null;
};

const FALLBACK: DeployEnv = { name: "production", type: "production", gitBranch: null };

/**
 * Resolve the environment a deploy runs under.
 *
 * The id is caller-supplied, so the lookup is scoped to the app being deployed.
 * An id that names no environment of this app — deleted, or on another app —
 * throws rather than resolving to production: falling back would deploy a
 * preview's branch over the live app.
 */
export async function resolveDeployEnv(
  appId: string,
  environmentId: string | undefined | null,
  load: DeployEnvLoader = defaultLoader,
): Promise<DeployEnv> {
  if (!environmentId) return FALLBACK;
  const env = await load(appId, environmentId);
  if (!env) {
    throw new DeployBlockedError(`Environment ${environmentId} does not exist on this app — refusing to deploy`);
  }
  return { name: env.name, type: env.type, gitBranch: env.gitBranch };
}
