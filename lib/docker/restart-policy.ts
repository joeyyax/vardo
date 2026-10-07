// Standby restart-policy demotion.
// Docker revives a stopped `restart: always` container on daemon restart: two writers on the same volumes.

import { COMPOSE_QUERY_TIMEOUT } from "./constants";
import { logger } from "@/lib/logger";
import { execFileAsync } from "@/lib/utils/exec";

const log = logger.child("restart-policy");

/** Restart policy a slot's compose declares per service. */
type ServicePolicies = Record<string, string>;

async function projectContainers(
  composeFileArgs: string[],
  projectName: string,
  cwd: string,
): Promise<{ id: string; service: string }[]> {
  const { stdout } = await execFileAsync(
    "docker",
    ["compose", ...composeFileArgs, "-p", projectName, "ps", "-a", "--format", "json"],
    { cwd, timeout: COMPOSE_QUERY_TIMEOUT },
  );
  const out: { id: string; service: string }[] = [];
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.ID) out.push({ id: parsed.ID, service: parsed.Service ?? "" });
    } catch {
      // Non-JSON compose noise.
    }
  }
  return out;
}

async function declaredPolicies(
  composeFileArgs: string[],
  projectName: string,
  cwd: string,
): Promise<ServicePolicies> {
  const { stdout } = await execFileAsync(
    "docker",
    ["compose", ...composeFileArgs, "-p", projectName, "config", "--format", "json"],
    { cwd, timeout: COMPOSE_QUERY_TIMEOUT },
  );
  const policies: ServicePolicies = {};
  const services = JSON.parse(stdout)?.services ?? {};
  for (const [name, svc] of Object.entries<{ restart?: string }>(services)) {
    if (svc?.restart) policies[name] = svc.restart;
  }
  return policies;
}

/** Pin a stopped slot's containers to `restart: no`. Best effort; logs on failure. */
export async function demoteStandbyRestart(
  composeFileArgs: string[],
  projectName: string,
  cwd: string,
): Promise<void> {
  try {
    const containers = await projectContainers(composeFileArgs, projectName, cwd);
    if (containers.length === 0) return;
    await execFileAsync(
      "docker",
      ["update", "--restart=no", ...containers.map((c) => c.id)],
      { timeout: COMPOSE_QUERY_TIMEOUT },
    );
  } catch (err) {
    log.warn(
      `Could not demote restart policy for ${projectName}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Fallback when a slot's compose declares no policy, matching compose-normalize. */
const DEFAULT_POLICY = "unless-stopped";

/** Restore each container's compose-declared restart policy when a demoted slot is promoted. */
export async function restoreSlotRestart(
  composeFileArgs: string[],
  projectName: string,
  cwd: string,
): Promise<void> {
  try {
    const [containers, policies] = await Promise.all([
      projectContainers(composeFileArgs, projectName, cwd),
      declaredPolicies(composeFileArgs, projectName, cwd),
    ]);
    for (const c of containers) {
      const policy = policies[c.service] || DEFAULT_POLICY;
      await execFileAsync("docker", ["update", `--restart=${policy}`, c.id], {
        timeout: COMPOSE_QUERY_TIMEOUT,
      }).catch(() => {});
    }
  } catch (err) {
    log.warn(
      `Could not restore restart policy for ${projectName}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
