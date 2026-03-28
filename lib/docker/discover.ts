import { listContainers, inspectContainer } from "./client";
import type { ContainerInspect } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscoveredContainer = {
  id: string;
  name: string;
  image: string;
  state: string;
  ports: { internal: number; external?: number; protocol: string }[];
  domain: string | null;
  containerPort: number | null;
  mounts: { source: string; destination: string; type: string }[];
  composeProject: string | null;
  networkMode: string;
};

export type DiscoveryResponse = {
  standalone: DiscoveredContainer[];
  groups: {
    composeProject: string;
    containers: DiscoveredContainer[];
  }[];
};

export type ContainerDetail = DiscoveredContainer & {
  env: string[];
  networks: string[];
  labels: Record<string, string>;
  capAdd: string[];
  capDrop: string[];
  devices: { hostPath: string; containerPath: string; permissions: string }[];
  privileged: boolean;
  securityOpt: string[];
  shmSize: number;
  init: boolean;
  extraHosts: string[];
  restartPolicy: string;
  nanoCpus: number;
  memoryBytes: number;
  ulimits: { name: string; soft: number; hard: number }[];
  tmpfs: string[];
  hostname: string;
  user: string;
  stopSignal: string;
  healthcheck: {
    test: string[];
    interval: number;
    timeout: number;
    retries: number;
    startPeriod: number;
  } | null;
  entrypoint: string[];
  command: string[];
};

// ---------------------------------------------------------------------------
// Traefik label parsing
// ---------------------------------------------------------------------------

export function parseTraefikDomain(labels: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(labels)) {
    if (/^traefik\.http\.routers\..+\.rule$/.test(key)) {
      const match = value.match(/Host\(`([^`]+)`\)/);
      if (match) return match[1];
    }
  }
  return null;
}

export function parseTraefikPort(labels: Record<string, string>): number | null {
  for (const [key, value] of Object.entries(labels)) {
    if (/^traefik\.http\.services\..+\.loadbalancer\.server\.port$/.test(key)) {
      const port = parseInt(value, 10);
      return isNaN(port) ? null : port;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Returns true if the container is Vardo-managed and should be excluded
 * from discovery. Checks both the new vardo.* and legacy host.* label prefixes.
 */
function isManagedContainer(labels: Record<string, string>): boolean {
  if (labels["vardo.project"] || labels["host.project"]) return true;
  if (labels["com.docker.compose.project"] === "vardo") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Shape conversion
// ---------------------------------------------------------------------------

function rawToDiscovered(
  id: string,
  name: string,
  image: string,
  state: string,
  ports: { internal: number; external?: number; protocol: string }[],
  labels: Record<string, string>,
  mounts: { source: string; destination: string; type: string }[],
  networkMode: string,
): DiscoveredContainer {
  return {
    id,
    name,
    image,
    state,
    ports,
    domain: parseTraefikDomain(labels),
    containerPort: parseTraefikPort(labels),
    mounts,
    composeProject: labels["com.docker.compose.project"] ?? null,
    networkMode,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * List all running containers that are not Vardo-managed.
 * Groups them by compose project; standalone containers have no compose project label.
 */
export async function discoverContainers(): Promise<DiscoveryResponse> {
  const all = await listContainers();
  const unmanaged = all.filter((c) => !isManagedContainer(c.labels));

  const discovered: DiscoveredContainer[] = unmanaged.map((c) =>
    rawToDiscovered(
      c.id,
      c.name,
      c.image,
      c.state,
      c.ports,
      c.labels,
      [],
      "unknown",
    )
  );

  return groupByComposeProject(discovered);
}

/**
 * Split discovered containers into standalone and compose groups.
 */
export function groupByComposeProject(containers: DiscoveredContainer[]): DiscoveryResponse {
  const standalone: DiscoveredContainer[] = [];
  const groupMap = new Map<string, DiscoveredContainer[]>();

  for (const c of containers) {
    if (!c.composeProject) {
      standalone.push(c);
    } else {
      const existing = groupMap.get(c.composeProject) ?? [];
      existing.push(c);
      groupMap.set(c.composeProject, existing);
    }
  }

  const groups = Array.from(groupMap.entries()).map(([composeProject, cs]) => ({
    composeProject,
    containers: cs,
  }));

  return { standalone, groups };
}

// ---------------------------------------------------------------------------
// Container detail (for import pre-fill)
// ---------------------------------------------------------------------------

/**
 * Inspect a single container and return enriched detail including env vars.
 * Verifies the container is not Vardo-managed before returning.
 */
export async function getContainerDetail(containerId: string): Promise<ContainerDetail | null> {
  const data: ContainerInspect = await inspectContainer(containerId);

  if (isManagedContainer(data.labels)) {
    return null;
  }

  const networkMode = data.networkMode;

  return {
    id: data.id,
    name: data.name,
    image: data.image,
    state: data.state.status,
    ports: data.ports,
    domain: parseTraefikDomain(data.labels),
    containerPort: parseTraefikPort(data.labels),
    mounts: data.mounts,
    composeProject: data.labels["com.docker.compose.project"] ?? null,
    networkMode,
    env: data.env,
    networks: data.networks,
    labels: data.labels,
    capAdd: data.capAdd,
    capDrop: data.capDrop,
    devices: data.devices,
    privileged: data.privileged,
    securityOpt: data.securityOpt,
    shmSize: data.shmSize,
    init: data.init,
    extraHosts: data.extraHosts,
    restartPolicy: data.restartPolicy,
    nanoCpus: data.nanoCpus,
    memoryBytes: data.memoryBytes,
    ulimits: data.ulimits,
    tmpfs: data.tmpfs,
    hostname: data.hostname,
    user: data.user,
    stopSignal: data.stopSignal,
    healthcheck: data.healthcheck,
    entrypoint: data.entrypoint,
    command: data.command,
  };
}

// ---------------------------------------------------------------------------
// Import payload builder
// ---------------------------------------------------------------------------

/**
 * Check whether an image name looks local (no registry prefix or short hash).
 * Used to warn users that the image may not be pullable.
 */
export function isLocalImage(imageName: string): boolean {
  // Short hash — no colons, no slashes, all hex
  if (/^[a-f0-9]{6,64}$/.test(imageName)) return true;
  // sha256 digest prefix
  if (imageName.startsWith("sha256:")) return true;
  // Images without any tag and no registry prefix or namespace are likely untagged local builds.
  // Images with a tag (e.g. "nginx:latest", "myapp:1.0") are ambiguous — Docker Hub official
  // images have no slash and no registry prefix yet are pullable. We only flag the no-tag case
  // here; images with a colon-tag are treated as potentially pullable to avoid false positives.
  if (imageName.includes(":") || imageName.includes("/")) return false;
  return imageName !== "scratch";
}
