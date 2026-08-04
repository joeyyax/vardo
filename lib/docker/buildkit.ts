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
export const DEFAULT_BUILDKIT_HOST = "docker-container://buildkit";

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

/** Throws a deploy-blocking error when the named BuildKit container is not running. */
export async function assertBuildKitReachable(
  host: string,
  signal?: AbortSignal,
): Promise<void> {
  const container = buildKitContainerName(host);
  if (!container) return;

  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", container],
      { timeout: DOCKER_CLEANUP_TIMEOUT, signal },
    );
    if (stdout.trim() === "true") return;
  } catch {
    // Absent and stopped read the same way to an operator, and the fix is the
    // same, so both fall through to one message.
  }

  throw new DeployBlockedError(
    `Railpack needs BuildKit, and no running container named "${container}" was found.\n` +
      `Start one on the Docker host:\n` +
      `  docker run -d --name ${container} --restart unless-stopped --privileged moby/buildkit\n` +
      `Or set BUILDKIT_HOST to an existing daemon.`,
  );
}
