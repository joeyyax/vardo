// ---------------------------------------------------------------------------
// BuildKit
//
// Railpack builds through BuildKit rather than the Docker daemon. When it can't
// reach one it exits non-zero with only a hint, after the deploy has already
// cloned and staged — so the check belongs before the build starts.
// ---------------------------------------------------------------------------

import { execFile } from "child_process";
import { promisify } from "util";

import { DOCKER_CLEANUP_TIMEOUT } from "./constants";
import { DeployBlockedError } from "./errors";

const execFileAsync = promisify(execFile);

const DOCKER_CONTAINER_PREFIX = "docker-container://";

/** Where Railpack looks for BuildKit when the environment does not say. */
export const DEFAULT_BUILDKIT_HOST = "docker-container://vardo-buildkit";

/**
 * Container a BUILDKIT_HOST points at, or null for any other transport.
 *
 * Only `docker-container://` can be checked from here. A tcp:// or unix://
 * daemon is somebody's deliberate configuration and is left to Railpack.
 */
export function buildKitContainerName(host: string): string | null {
  if (!host.startsWith(DOCKER_CONTAINER_PREFIX)) return null;
  const name = host.slice(DOCKER_CONTAINER_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

/**
 * Whether BuildKit can be reached. Never throws — for choosing a builder, where
 * "no" is an answer rather than a failure.
 *
 * A transport this cannot inspect is taken at its word and reported reachable;
 * the build will surface the truth soon enough.
 */
export async function isBuildKitReachable(host: string, signal?: AbortSignal): Promise<boolean> {
  const container = buildKitContainerName(host);
  if (!container) return true;

  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", container],
      { timeout: DOCKER_CLEANUP_TIMEOUT, signal },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Throws a deploy-blocking error when the named BuildKit container is not running. */
export async function assertBuildKitReachable(
  host: string,
  signal?: AbortSignal,
): Promise<void> {
  const container = buildKitContainerName(host);
  if (!container) return;
  if (await isBuildKitReachable(host, signal)) return;

  throw new DeployBlockedError(
    `Railpack needs BuildKit, and no running container named "${container}" was found.\n` +
      `Add "buildkit" to COMPOSE_PROFILES on the Docker host and bring the stack up:\n` +
      `  COMPOSE_PROFILES=production,buildkit docker compose up -d buildkit\n` +
      `Or point BUILDKIT_HOST at a daemon you run yourself. Nixpacks needs none of this.`,
  );
}
