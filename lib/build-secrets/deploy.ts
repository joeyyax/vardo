import type { DeployContext } from "@/lib/docker/deploy-context";
import { resolveBuildSecrets, type BuildSecrets } from "@/lib/docker/build-secrets";
import { orgBuildSecretValues } from "./store";

/** The deploy's build secrets: the org's, then the GitHub App token for an id the org doesn't set. */
export async function loadBuildSecrets(
  ctx: Pick<DeployContext, "organizationId" | "log" | "addSecrets" | "buildSecrets">,
  appToken: string | null,
): Promise<void> {
  let org: BuildSecrets = {};
  try {
    const { secrets, failed } = await orgBuildSecretValues(ctx.organizationId);
    org = secrets;
    if (failed.length > 0) ctx.log(`[deploy] Warning: couldn't decrypt build secret ${failed.join(", ")}; check ENCRYPTION_MASTER_KEY`);
  } catch (err) {
    ctx.log(`[deploy] Warning: couldn't read the org's build secrets: ${err instanceof Error ? err.message : err}`);
  }
  const { secrets, sources } = resolveBuildSecrets(appToken, org);
  ctx.addSecrets?.(Object.fromEntries(Object.entries(secrets).map(([id, value]) => [`BUILD_SECRET_${id}`, value])));
  ctx.buildSecrets = secrets;
  const named = Object.entries(sources).map(([id, from]) => `${id} (${from === "organization" ? "org secret" : "GitHub App token"})`);
  if (named.length > 0) ctx.log(`[deploy] Build secrets: ${named.join(", ")}`);
}
