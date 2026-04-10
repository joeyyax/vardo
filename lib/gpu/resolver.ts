import { readFile } from "node:fs/promises";
import { listContainers, type ContainerInfo } from "@/lib/docker/client";
import { logger } from "@/lib/logger";
import type { ContainerResolver } from "./types";

const log = logger.child("gpu-resolver");

const PID_CACHE_TTL_MS = 5000;
const CONTAINER_LIST_TTL_MS = 10_000;

/**
 * Docker container resolver — maps PIDs to containers via /proc cgroups,
 * then containers to Vardo apps via Docker labels.
 *
 * Caches the full container list per TTL so multiple PID lookups in a
 * single tick share one Docker API call.
 */
export class DockerContainerResolver implements ContainerResolver {
  // PID → container ID cache (short TTL — processes don't move between containers)
  private pidCache = new Map<number, { containerId: string | null; cachedAt: number }>();

  // Full container list cache — one Docker API call shared across all lookups
  private containerListCache: { containers: ContainerInfo[]; cachedAt: number } | null = null;

  async pidToContainerId(pid: number): Promise<string | null> {
    const cached = this.pidCache.get(pid);
    if (cached && Date.now() - cached.cachedAt < PID_CACHE_TTL_MS) {
      return cached.containerId;
    }

    const containerId = await readContainerIdFromCgroup(pid);
    this.pidCache.set(pid, { containerId, cachedAt: Date.now() });
    return containerId;
  }

  async containerIdToApp(containerId: string): Promise<{
    projectName: string;
    containerName: string;
    organizationId: string | null;
  } | null> {
    const containers = await this.getContainerList();
    const match = containers.find((c) => c.id.startsWith(containerId) || containerId.startsWith(c.id));
    if (!match) return null;

    const projectName = match.labels["vardo.project"] || match.labels["host.project"];
    if (!projectName) return null;

    return {
      projectName,
      containerName: match.name,
      organizationId: match.labels["vardo.organization"] || match.labels["host.organization"] || null,
    };
  }

  /** Fetch or return cached container list. One Docker API call per TTL window. */
  private async getContainerList(): Promise<ContainerInfo[]> {
    if (this.containerListCache && Date.now() - this.containerListCache.cachedAt < CONTAINER_LIST_TTL_MS) {
      return this.containerListCache.containers;
    }

    try {
      const containers = await listContainers();
      this.containerListCache = { containers, cachedAt: Date.now() };
      return containers;
    } catch (err) {
      log.warn("Failed to list containers:", (err as Error).message);
      return this.containerListCache?.containers ?? [];
    }
  }
}

// ---------------------------------------------------------------------------
// /proc/{pid}/cgroup parsing
// ---------------------------------------------------------------------------

/**
 * Read /proc/{pid}/cgroup to extract the Docker container ID.
 *
 * cgroup v2 format: `0::/system.slice/docker-{64-hex-chars}.scope`
 * cgroup v1 format: `N:name:/docker/{64-hex-chars}`
 *
 * Returns the first 12 chars (short ID) to match Docker API conventions.
 */
async function readContainerIdFromCgroup(pid: number): Promise<string | null> {
  try {
    const content = await readFile(`/proc/${pid}/cgroup`, "utf-8");

    for (const line of content.split("\n")) {
      // cgroup v2: docker-<id>.scope
      const v2Match = line.match(/docker-([0-9a-f]{64})\.scope/);
      if (v2Match) return v2Match[1].slice(0, 12);

      // cgroup v1: /docker/<id>
      const v1Match = line.match(/\/docker\/([0-9a-f]{64})/);
      if (v1Match) return v1Match[1].slice(0, 12);

      // containerd: /cri-containerd-<id>.scope
      const containerdMatch = line.match(/cri-containerd-([0-9a-f]{64})\.scope/);
      if (containerdMatch) return containerdMatch[1].slice(0, 12);
    }

    return null;
  } catch {
    // /proc not available or PID gone — expected on non-Linux or after process exits
    return null;
  }
}
