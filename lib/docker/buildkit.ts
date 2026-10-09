// BuildKit reachability checks for Railpack builds, run before the build starts.

import { DOCKER_CLEANUP_TIMEOUT } from "./constants";
import { DeployBlockedError } from "./errors";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";

const DOCKER_CONTAINER_PREFIX = "docker-container://";

/** Where Railpack looks for BuildKit when the environment does not say. */
export const DEFAULT_BUILDKIT_HOST = "docker-container://vardo-buildkit";

/** Container a `docker-container://` BUILDKIT_HOST points at, or null for any other transport. */
export function buildKitContainerName(host: string): string | null {
  if (!host.startsWith(DOCKER_CONTAINER_PREFIX)) return null;
  const name = host.slice(DOCKER_CONTAINER_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

/** Whether BuildKit can be reached. Never throws; uninspectable transports report reachable. */
export async function isBuildKitReachable(host: string, signal?: AbortSignal): Promise<boolean> {
  const container = buildKitContainerName(host);
  if (!container) return true;

  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", container],
      { env: dockerEnv(), timeout: DOCKER_CLEANUP_TIMEOUT, signal },
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

type CacheRecord = { size?: number; inUse?: boolean; shared?: boolean };

/** Total and reclaimable bytes from `buildctl du --format '{{json .}}'`. */
export function parseBuildKitDu(stdout: string): { totalSize: number; reclaimable: number } {
  const records = JSON.parse(stdout.trim() || "[]") as CacheRecord[] | null;
  let totalSize = 0;
  let reclaimable = 0;
  for (const r of records ?? []) {
    const size = typeof r.size === "number" && r.size > 0 ? r.size : 0;
    totalSize += size;
    if (!r.inUse && !r.shared) reclaimable += size;
  }
  return { totalSize, reclaimable };
}

/** Bytes removed, from `buildctl prune --format '{{json .}}'`, one record per line. */
export function parseBuildKitPrune(stdout: string): number {
  let bytes = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const size = (JSON.parse(line) as CacheRecord).size;
    if (typeof size === "number" && size > 0) bytes += size;
  }
  return bytes;
}

function buildctl(container: string, args: string[], timeout = DOCKER_CLEANUP_TIMEOUT) {
  return execFileAsync("docker", ["exec", container, "buildctl", ...args, "--format", "{{json .}}"], {
    env: dockerEnv(),
    timeout,
    maxBuffer: 50 * 1024 * 1024,
  });
}

/** The BuildKit container's cache, which `docker system df` doesn't see. Null when BuildKit isn't running. */
export async function getBuildKitCacheUsage(
  host = process.env.BUILDKIT_HOST || DEFAULT_BUILDKIT_HOST,
): Promise<{ totalSize: number; reclaimable: number } | null> {
  const container = buildKitContainerName(host);
  if (!container || !(await isBuildKitReachable(host))) return null;
  try {
    return parseBuildKitDu((await buildctl(container, ["du"])).stdout);
  } catch {
    return null;
  }
}

/** Empties the BuildKit container's cache. Returns bytes freed, or 0 when BuildKit isn't running. */
export async function pruneBuildKitCache(host = process.env.BUILDKIT_HOST || DEFAULT_BUILDKIT_HOST): Promise<number> {
  const container = buildKitContainerName(host);
  if (!container || !(await isBuildKitReachable(host))) return 0;
  return parseBuildKitPrune((await buildctl(container, ["prune", "--all"], DOCKER_CLEANUP_TIMEOUT * 4)).stdout);
}
