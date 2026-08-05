// ---------------------------------------------------------------------------
// BuildKit
//
// Railpack builds through BuildKit rather than the Docker daemon. When it can't
// reach one it exits non-zero with only a hint, after the deploy has already
// cloned and staged — so the check belongs before the build starts.
// ---------------------------------------------------------------------------


import { DOCKER_CLEANUP_TIMEOUT } from "./constants";
import { DeployBlockedError } from "./errors";
import { execFileAsync } from "@/lib/utils/exec";

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

/**
 * Prune BuildKit's own store back to a ceiling, returning the bytes reclaimed.
 * Nothing else touches it — `docker builder prune` bounds the daemon's cache,
 * not this one.
 *
 * Reclaims nothing and stays silent when the daemon is not reachable, or when
 * the transport is one this cannot exec into.
 */
export async function pruneBuildKitCache(
  host: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ spaceReclaimed: number }> {
  const container = buildKitContainerName(host);
  if (!container) return { spaceReclaimed: 0 };
  if (!(await isBuildKitReachable(host, signal))) return { spaceReclaimed: 0 };

  // `--keep-storage` is megabytes, not bytes, and is the daemon's
  // max-used-space: a ceiling, so the call is already a no-op when under it.
  const keepStorageMb = Math.max(1, Math.floor(maxBytes / 1e6));
  const { stdout } = await execFileAsync(
    "docker",
    [
      "exec",
      container,
      "buildctl",
      "prune",
      "--keep-storage",
      String(keepStorageMb),
      // One record size per line. The default output only totals in human units.
      "--format",
      "{{.Size}}",
    ],
    { timeout: DOCKER_CLEANUP_TIMEOUT, signal },
  );

  const spaceReclaimed = stdout
    .split("\n")
    .reduce((total, line) => total + (Number(line.trim()) || 0), 0);

  return { spaceReclaimed };
}
