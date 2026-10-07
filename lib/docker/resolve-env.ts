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
  id: string | null;
  name: string;
  type: EnvType;
  gitBranch: string | null;
  /** The app's own environment, the one apps.status and domain rows describe. */
  isDefault: boolean;
  domain: string | null;
};

type DeployEnvRow = {
  id: string;
  name: string;
  type: EnvType;
  gitBranch: string | null;
  isDefault: boolean | null;
  domain: string | null;
};

/** Injectable environments-table loader. */
export type DeployEnvLoader = (
  appId: string,
  environmentId: string,
) => Promise<DeployEnvRow | null>;

const defaultLoader: DeployEnvLoader = async (appId, environmentId) => {
  const row = await db.query.environments.findFirst({
    where: and(eq(environments.id, environmentId), eq(environments.appId, appId)),
    columns: { id: true, name: true, type: true, gitBranch: true, isDefault: true, domain: true },
  });
  return row ?? null;
};

const FALLBACK: DeployEnv = {
  id: null,
  name: "production",
  type: "production",
  gitBranch: null,
  isDefault: true,
  domain: null,
};

/**
 * Resolve the environment a deploy runs under, scoped to the app.
 * An unknown id throws: falling back to production would deploy a preview's branch over the live app.
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
  return {
    id: env.id,
    name: env.name,
    type: env.type,
    gitBranch: env.gitBranch,
    isDefault: env.isDefault ?? false,
    domain: env.domain,
  };
}
