// ---------------------------------------------------------------------------
// Standby restart-policy demotion
//
// Docker restarts a `restart: always` container when the daemon restarts even
// if it was explicitly stopped. A stopped standby slot would come back up
// alongside the active one — two writers against the same named volumes. The
// generated compose no longer emits `always` (see compose-normalize), but
// containers created before that, or created outside Vardo, still carry it.
// ---------------------------------------------------------------------------

import { execFile } from "child_process";
import { promisify } from "util";

import { COMPOSE_QUERY_TIMEOUT } from "./constants";
import { logger } from "@/lib/logger";

const execFileAsync = promisify(execFile);
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
      // A non-JSON line is compose noise, not a container.
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

/**
 * Pin a stopped slot's containers to `restart: no` so the daemon cannot bring
 * them back. Best-effort — a standby that keeps its policy is a hazard worth
 * logging, never a reason to fail the deploy that just succeeded.
 */
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

/**
 * Fallback when a slot's compose declares no policy, matching what
 * compose-normalize writes. A demoted container carries `no` from the demote
 * rather than from its own compose, so leaving it there would strand a promoted
 * slot with no crash recovery.
 */
const DEFAULT_POLICY = "unless-stopped";

/**
 * Put each container's compose-declared restart policy back. Runs when a
 * demoted slot is promoted to serving, so it restarts on crash like any other.
 */
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
