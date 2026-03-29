import { listContainers, inspectContainer, inspectImageEnv } from "./client";
import type { ContainerInspect, ContainerRuntimeOptions } from "./client";

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
  mounts: { name: string; source: string; destination: string; type: string }[];
  composeProject: string | null;
  networkMode: string;
  hasGpu: boolean;
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
} & ContainerRuntimeOptions;

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

/**
 * Determine the most likely container port for HTTP routing.
 *
 * Priority:
 * 1. Traefik labels — explicit, authoritative
 * 2. ExposedPorts from Docker inspect (Config.ExposedPorts) — declared listening port
 *    - Single port: use it directly
 *    - Multiple: prefer common HTTP ports in order: 80, 8080, 3000, 8000, 443, 8443
 * 3. PortBindings (host-mapped ports, internal side) — last resort
 */
export function detectContainerPort(
  labels: Record<string, string>,
  exposedPorts: number[],
  boundPorts: number[] = [],
): number | null {
  const traefikPort = parseTraefikPort(labels);
  if (traefikPort !== null) return traefikPort;

  if (exposedPorts.length === 1) return exposedPorts[0];
  if (exposedPorts.length > 1) {
    const preferred = [80, 8080, 3000, 8000, 443, 8443];
    for (const p of preferred) {
      if (exposedPorts.includes(p)) return p;
    }
    return exposedPorts[0];
  }

  if (boundPorts.length > 0) return boundPorts[0];

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
// GPU detection
// ---------------------------------------------------------------------------

/**
 * Best-effort GPU heuristic for discovered containers.
 * Checks image name and labels for NVIDIA indicators since the list-containers
 * API does not expose env vars or device mounts.
 */
export function detectContainerGpu(image: string, labels: Record<string, string>): boolean {
  const img = image.toLowerCase();
  if (img.includes("nvidia") || img.includes("cuda") || img.startsWith("nvcr.io/")) return true;
  // NVIDIA runtime labels
  if (labels["com.nvidia.volumes.needed"] || labels["com.nvidia.cuda.version"]) return true;
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
  mounts: { name: string; source: string; destination: string; type: string }[],
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
    hasGpu: detectContainerGpu(image, labels),
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
 * Remove env vars that are identical to what the image provides.
 *
 * Docker containers inherit env vars from their image (PATH, LANG, etc.).
 * During import we only want the delta — vars that were explicitly set or
 * overridden at container run time. Capturing inherited vars causes broken
 * containers because the values are locked to whatever was in the image at
 * import time, overriding anything the new image version might set.
 *
 * Vars that share a key with the image but have a different value are kept
 * because they represent explicit runtime overrides.
 */
export function filterImageInheritedEnv(
  containerEnv: string[],
  imageEnv: string[],
): string[] {
  const imageSet = new Set(imageEnv);
  return containerEnv.filter((e) => !imageSet.has(e));
}

/**
 * Inspect a single container and return enriched detail including env vars.
 * Verifies the container is not Vardo-managed before returning.
 *
 * Env vars inherited from the image are filtered out — only vars that were
 * explicitly set or overridden at runtime are included.
 */
export async function getContainerDetail(containerId: string): Promise<ContainerDetail | null> {
  const data: ContainerInspect = await inspectContainer(containerId);

  if (isManagedContainer(data.labels)) {
    return null;
  }

  const networkMode = data.networkMode;

  const hasNvidiaEnv = data.env.some((e) => e.startsWith("NVIDIA_VISIBLE_DEVICES=") || e.startsWith("NVIDIA_DRIVER_CAPABILITIES="));
  const hasNvidiaDevice = data.devices.some((d) => d.hostPath.startsWith("/dev/nvidia") || d.containerPath.startsWith("/dev/nvidia"));

  // Filter out env vars that come from the image itself. Only the delta
  // (vars explicitly set or overridden at run time) is meaningful to capture.
  // If the image inspect fails for any reason we fall back to the full list.
  const imageEnv = await inspectImageEnv(data.image);
  const filteredEnv = filterImageInheritedEnv(data.env, imageEnv);

  return {
    id: data.id,
    name: data.name,
    image: data.image,
    state: data.state.status,
    ports: data.ports,
    domain: parseTraefikDomain(data.labels),
    containerPort: detectContainerPort(
      data.labels,
      data.exposedPorts,
      data.ports.map((p) => p.internal),
    ),
    mounts: data.mounts,
    composeProject: data.labels["com.docker.compose.project"] ?? null,
    networkMode,
    hasGpu: detectContainerGpu(data.image, data.labels) || hasNvidiaEnv || hasNvidiaDevice,
    env: filteredEnv,
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
