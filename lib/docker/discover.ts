import { listContainers, inspectContainer, inspectImageEnv } from "./client";
import type { ContainerInspect, ContainerRuntimeOptions } from "./client";

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

// HTTP ports in preference order when a container exposes several.
const PREFERRED_HTTP_PORTS = [80, 8080, 3000, 8000, 443, 8443];

/** Most likely HTTP port: Traefik label, then exposed ports (preferring common HTTP ports), then bound ports. */
export function detectContainerPort(
  labels: Record<string, string>,
  exposedPorts: number[],
  boundPorts: number[] = [],
): number | null {
  const traefikPort = parseTraefikPort(labels);
  if (traefikPort !== null) return traefikPort;

  if (exposedPorts.length === 1) return exposedPorts[0];
  if (exposedPorts.length > 1) {
    for (const p of PREFERRED_HTTP_PORTS) {
      if (exposedPorts.includes(p)) return p;
    }
    return exposedPorts[0];
  }

  if (boundPorts.length > 0) return boundPorts[0];

  return null;
}

/** Whether the container is Vardo-managed (vardo.* or legacy host.* labels). */
function isManagedContainer(labels: Record<string, string>): boolean {
  if (labels["vardo.project"] || labels["host.project"]) return true;
  if (labels["com.docker.compose.project"] === "vardo") return true;
  return false;
}

/** Best-effort GPU guess from image name and NVIDIA labels. */
export function detectContainerGpu(image: string, labels: Record<string, string>): boolean {
  const img = image.toLowerCase();
  if (img.includes("nvidia") || img.includes("cuda") || img.startsWith("nvcr.io/")) return true;
  if (labels["com.nvidia.volumes.needed"] || labels["com.nvidia.cuda.version"]) return true;
  return false;
}

type DiscoveredPort = DiscoveredContainer["ports"][number];

/** One entry per host port, container port and protocol, sorted. Docker reports one binding per address family. */
export function dedupePorts(ports: DiscoveredPort[]): DiscoveredPort[] {
  const seen = new Map<string, DiscoveredPort>();
  for (const p of ports) {
    seen.set(`${p.external ?? ""}:${p.internal}/${p.protocol}`, p);
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.internal - b.internal ||
      (a.external ?? 0) - (b.external ?? 0) ||
      a.protocol.localeCompare(b.protocol),
  );
}

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
    ports: dedupePorts(ports),
    domain: parseTraefikDomain(labels),
    containerPort: parseTraefikPort(labels),
    mounts,
    composeProject: labels["com.docker.compose.project"] ?? null,
    networkMode,
    hasGpu: detectContainerGpu(image, labels),
  };
}

/** Running containers not managed by Vardo, grouped by compose project. */
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

/** Split discovered containers into standalone and compose groups. */
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

/** Keys the runtime rewrites, so their value never matches the image's. Dropped by key when the image sets them. */
const RUNTIME_OWNED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "HOSTNAME",
  "TERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "PWD",
  "SHLVL",
  "_",
]);

/** Drop env vars inherited from the image, keeping runtime overrides. */
export function filterImageInheritedEnv(
  containerEnv: string[],
  imageEnv: string[],
): string[] {
  const imageSet = new Set(imageEnv);
  const imageKeys = new Set(imageEnv.map((e) => e.split("=", 1)[0]));
  return containerEnv.filter((e) => {
    if (imageSet.has(e)) return false;
    const key = e.split("=", 1)[0];
    return !(RUNTIME_OWNED_ENV_KEYS.has(key) && imageKeys.has(key));
  });
}

/** Inspect an unmanaged container for import, with image-inherited env vars removed. Null if managed. */
export async function getContainerDetail(containerId: string): Promise<ContainerDetail | null> {
  const data: ContainerInspect = await inspectContainer(containerId);

  if (isManagedContainer(data.labels)) {
    return null;
  }

  const networkMode = data.networkMode;

  const hasNvidiaEnv = data.env.some((e) => e.startsWith("NVIDIA_VISIBLE_DEVICES=") || e.startsWith("NVIDIA_DRIVER_CAPABILITIES="));
  const hasNvidiaDevice = data.devices.some((d) => d.hostPath.startsWith("/dev/nvidia") || d.containerPath.startsWith("/dev/nvidia"));

  const imageEnv = await inspectImageEnv(data.image);
  const filteredEnv = filterImageInheritedEnv(data.env, imageEnv);

  return {
    id: data.id,
    name: data.name,
    image: data.image,
    state: data.state.status,
    ports: dedupePorts(data.ports),
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

/** Whether any traefik.* label references the file provider (`@file`). */
export function hasAtFileTraefikLabels(labels: Record<string, string>): boolean {
  return Object.entries(labels).some(([k, v]) => k.startsWith("traefik.") && v.includes("@file"));
}

/** Whether an image name looks like a local build that may not be pullable. */
export function isLocalImage(imageName: string): boolean {
  // Short hash
  if (/^[a-f0-9]{6,64}$/.test(imageName)) return true;
  if (imageName.startsWith("sha256:")) return true;
  // Only a bare untagged name counts; tagged names may be Docker Hub official images.
  if (imageName.includes(":") || imageName.includes("/")) return false;
  return imageName !== "scratch";
}
