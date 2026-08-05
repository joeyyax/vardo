import { db } from "@/lib/db";
import { environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

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
 * The id is caller-supplied, so the lookup is scoped to the app being deployed:
 * an environment on another app — in this org or any other — resolves to
 * production rather than lending the deploy its name, branch or type. Type
 * matters most: `local` turns on bind mounts.
 */
export async function resolveDeployEnv(
  appId: string,
  environmentId: string | undefined | null,
  load: DeployEnvLoader = defaultLoader,
): Promise<DeployEnv> {
  if (!environmentId) return FALLBACK;
  const env = await load(appId, environmentId);
  if (!env) return FALLBACK;
  return { name: env.name, type: env.type, gitBranch: env.gitBranch };
}
