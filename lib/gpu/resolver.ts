import { readFile } from "node:fs/promises";
import { listContainers, type ContainerInfo } from "@/lib/docker/client";
import { logger } from "@/lib/logger";
import type { ContainerResolver } from "./types";

const log = logger.child("gpu-resolver");

const CONTAINER_LIST_TTL_MS = 10_000;

/**
 * Host proc path — the Vardo container mounts host /proc at /host-proc
 * for PID-to-container resolution without Docker API calls.
 */
const HOST_PROC = "/host-proc";

/**
 * Docker container resolver — maps PIDs to containers by reading
 * /host-proc/{pid}/cgroup (host /proc mounted read-only), then maps
 * container IDs to Vardo apps via Docker labels.
 *
 * Zero Docker API calls for PID resolution — just filesystem reads.
 */
export class DockerContainerResolver implements ContainerResolver {
  private containerListCache: { containers: ContainerInfo[]; cachedAt: number } | null = null;

  async pidToContainerId(pid: number): Promise<string | null> {
    try {
      const content = await readFile(`${HOST_PROC}/${pid}/cgroup`, "utf-8");
      return parseCgroupContent(content);
    } catch {
      // PID gone or /host-proc not mounted — expected
      return null;
    }
  }

  async containerIdToApp(containerId: string): Promise<{
    projectName: string;
    containerName: string;
    organizationId: string | null;
  } | null> {
    const containers = await this.getContainerList();
    const match = containers.find((c) =>
      c.id.startsWith(containerId) || containerId.startsWith(c.id.slice(0, 12)),
    );
    if (!match) return null;

    const projectName = match.labels["vardo.project"] || match.labels["host.project"];
    if (!projectName) return null;

    return {
      projectName,
      containerName: match.name,
      organizationId: match.labels["vardo.organization"] || match.labels["host.organization"] || null,
    };
  }

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
// cgroup parsing
// ---------------------------------------------------------------------------

/**
 * Parse /proc/{pid}/cgroup content to extract Docker container ID.
 *
 * cgroup v2: `0::/system.slice/docker-{64hex}.scope`
 * cgroup v1: `N:name:/docker/{64hex}`
 *
 * Returns 12-char short ID to match Docker API conventions.
 */
function parseCgroupContent(content: string): string | null {
  for (const line of content.split("\n")) {
    const v2 = line.match(/docker-([0-9a-f]{64})\.scope/);
    if (v2) return v2[1].slice(0, 12);

    const v1 = line.match(/\/docker\/([0-9a-f]{64})/);
    if (v1) return v1[1].slice(0, 12);

    const cri = line.match(/cri-containerd-([0-9a-f]{64})\.scope/);
    if (cri) return cri[1].slice(0, 12);
  }
  return null;
}
