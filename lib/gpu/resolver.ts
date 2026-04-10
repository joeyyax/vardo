import { listContainers, dockerRequest, type ContainerInfo } from "@/lib/docker/client";
import { logger } from "@/lib/logger";
import type { ContainerResolver } from "./types";

const log = logger.child("gpu-resolver");

const PID_MAP_TTL_MS = 5000;
const CONTAINER_LIST_TTL_MS = 10_000;

/**
 * Docker container resolver — maps PIDs to containers via the Docker API
 * `top` endpoint, then containers to Vardo apps via Docker labels.
 *
 * Uses Docker API rather than /proc/pid/cgroup because the Vardo container
 * can't see host PIDs in its /proc. The Docker socket gives us access to
 * `GET /containers/{id}/top` which returns host PIDs for each container.
 */
export class DockerContainerResolver implements ContainerResolver {
  // PID → container ID lookup — rebuilt per TTL from Docker top endpoints
  private pidMap: { map: Map<number, string>; cachedAt: number } | null = null;

  // Full container list cache
  private containerListCache: { containers: ContainerInfo[]; cachedAt: number } | null = null;

  async pidToContainerId(pid: number): Promise<string | null> {
    const map = await this.getPidMap();
    return map.get(pid) ?? null;
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

  // ---------------------------------------------------------------------------
  // PID map via Docker API top
  // ---------------------------------------------------------------------------

  /**
   * Build a PID→containerID map by calling `GET /containers/{id}/top` on
   * all running containers. One batch of API calls per TTL window.
   */
  private async getPidMap(): Promise<Map<number, string>> {
    if (this.pidMap && Date.now() - this.pidMap.cachedAt < PID_MAP_TTL_MS) {
      return this.pidMap.map;
    }

    const containers = await this.getContainerList();
    const map = new Map<number, string>();

    const results = await Promise.allSettled(
      containers.map(async (c) => {
        try {
          const top = await dockerRequest<{
            Titles: string[];
            Processes: string[][];
          }>("GET", `/containers/${c.id}/top?ps_args=eo pid`);

          if (!top?.Processes) return;

          for (const proc of top.Processes) {
            const pid = parseInt(proc[0], 10);
            if (!isNaN(pid)) {
              map.set(pid, c.id);
            }
          }
        } catch {
          // Container may have stopped between list and top — skip it
        }
      }),
    );

    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      log.warn(`PID map: ${failed}/${containers.length} containers failed`);
    }

    this.pidMap = { map, cachedAt: Date.now() };
    return map;
  }

  // ---------------------------------------------------------------------------
  // Container list cache
  // ---------------------------------------------------------------------------

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
