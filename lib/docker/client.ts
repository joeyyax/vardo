import http from "node:http";
import { execFileSync } from "node:child_process";

// Detect the Docker daemon's API version at startup.
// Falls back to 1.47 if detection fails.
let DOCKER_API_VERSION = "1.47";
try {
  const out = execFileSync("docker", ["version", "--format", "{{.Server.APIVersion}}"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  const ver = out.trim();
  if (/^\d+\.\d+$/.test(ver)) {
    DOCKER_API_VERSION = ver;
  }
} catch {
  // Docker not available or detection failed — use fallback
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContainerInfo = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: { internal: number; external?: number; protocol: string }[];
  labels: Record<string, string>;
};

export type ContainerInspect = {
  id: string;
  name: string;
  state: { running: boolean; status: string; startedAt: string };
  image: string;
  ports: { internal: number; external?: number; protocol: string }[];
  env: string[];
  labels: Record<string, string>;
  networks: string[];
  networkMode: string;
  mounts: { source: string; destination: string; type: string }[];
};

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

export function getConnectionOptions(): { socketPath?: string; host?: string; port?: number } {
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost) {
    // tcp://host:port
    const url = new URL(dockerHost);
    return { host: url.hostname, port: Number(url.port) || 2375 };
  }
  return { socketPath: "/var/run/docker.sock" };
}

// ---------------------------------------------------------------------------
// Low-level request helper
// ---------------------------------------------------------------------------

export async function dockerRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const conn = getConnectionOptions();
  const payload = body ? JSON.stringify(body) : undefined;

  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        ...conn,
        path: `/v${DOCKER_API_VERSION}${path}`,
        method,
        headers: {
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");

          if (res.statusCode && res.statusCode >= 400) {
            let message = raw;
            try {
              const parsed = JSON.parse(raw);
              message = parsed.message ?? raw;
            } catch {
              // keep raw string
            }
            reject(
              new Error(`Docker API ${method} ${path} returned ${res.statusCode}: ${message}`),
            );
            return;
          }

          // Some endpoints return empty 204 responses
          if (!raw || raw.length === 0) {
            resolve(undefined as T);
            return;
          }

          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            // Return raw text (e.g. logs endpoint)
            resolve(raw as T);
          }
        });
      },
    );

    req.on("error", (err) => {
      reject(
        new Error(
          `Docker API request failed: ${err.message}. Is the Docker daemon running?`,
        ),
      );
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await dockerRequest("GET", "/_ping");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

export async function ensureNetwork(name: string): Promise<void> {
  // Check if network already exists
  const networks = await dockerRequest<{ Name: string }[]>(
    "GET",
    `/networks?filters=${encodeURIComponent(JSON.stringify({ name: [name] }))}`,
  );

  const exists = networks.some((n) => n.Name === name);
  if (exists) return;

  await dockerRequest("POST", "/networks/create", {
    Name: name,
    Driver: "bridge",
    CheckDuplicate: true,
  });
}

// ---------------------------------------------------------------------------
// Port parsing helpers
// ---------------------------------------------------------------------------

type ParsedPort = { internal: number; external?: number; protocol: string };

function parseListPorts(
  portsArray?: { PrivatePort: number; PublicPort?: number; Type: string }[],
): ParsedPort[] {
  if (!portsArray) return [];
  return portsArray.map((p) => ({
    internal: p.PrivatePort,
    external: p.PublicPort || undefined,
    protocol: p.Type,
  }));
}

function parseInspectPorts(
  portBindings?: Record<string, { HostPort: string }[] | null>,
): ParsedPort[] {
  if (!portBindings) return [];
  const ports: ParsedPort[] = [];

  for (const [containerPort, hostBindings] of Object.entries(portBindings)) {
    // containerPort is like "8080/tcp"
    const [portStr, protocol] = containerPort.split("/");
    const internal = parseInt(portStr, 10);

    if (hostBindings && hostBindings.length > 0) {
      for (const binding of hostBindings) {
        ports.push({
          internal,
          external: binding.HostPort ? parseInt(binding.HostPort, 10) : undefined,
          protocol: protocol || "tcp",
        });
      }
    } else {
      ports.push({ internal, protocol: protocol || "tcp" });
    }
  }

  return ports;
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

type RawContainer = {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Ports: { PrivatePort: number; PublicPort?: number; Type: string }[];
  Labels: Record<string, string>;
};

function mapRawContainer(c: RawContainer): ContainerInfo {
  return {
    id: c.Id,
    name: (c.Names[0] ?? "").replace(/^\//, ""),
    image: c.Image,
    state: c.State,
    status: c.Status,
    ports: parseListPorts(c.Ports),
    labels: c.Labels ?? {},
  };
}

export async function listContainers(projectLabel?: string, environmentLabel?: string): Promise<ContainerInfo[]> {
  if (!projectLabel) {
    const containers = await dockerRequest<RawContainer[]>("GET", "/containers/json");
    return containers.map(mapRawContainer);
  }

  // Query both vardo.* (new) and host.* (legacy) label prefixes and deduplicate by ID
  // to support containers deployed before the label rename.
  const results = await Promise.all(
    ["vardo", "host"].map((prefix) => {
      const labels = [`${prefix}.project=${projectLabel}`];
      if (environmentLabel) labels.push(`${prefix}.environment=${environmentLabel}`);
      const query = `?filters=${encodeURIComponent(JSON.stringify({ label: labels }))}`;
      return dockerRequest<RawContainer[]>("GET", `/containers/json${query}`);
    })
  );

  const seen = new Set<string>();
  return results.flat().filter((c) => {
    if (seen.has(c.Id)) return false;
    seen.add(c.Id);
    return true;
  }).map(mapRawContainer);
}

export async function inspectContainer(id: string): Promise<ContainerInspect> {
  const data = await dockerRequest<{
    Id: string;
    Name: string;
    State: { Running: boolean; Status: string; StartedAt: string };
    Config: {
      Image: string;
      Env: string[];
      Labels: Record<string, string>;
    };
    HostConfig: {
      PortBindings?: Record<string, { HostPort: string }[] | null>;
      NetworkMode?: string;
    };
    NetworkSettings: {
      Networks?: Record<string, unknown>;
    };
    Mounts: { Source: string; Destination: string; Type: string }[];
  }>("GET", `/containers/${id}/json`);

  return {
    id: data.Id,
    name: data.Name.replace(/^\//, ""),
    state: {
      running: data.State.Running,
      status: data.State.Status,
      startedAt: data.State.StartedAt,
    },
    image: data.Config.Image,
    ports: parseInspectPorts(data.HostConfig.PortBindings),
    env: data.Config.Env ?? [],
    labels: data.Config.Labels ?? {},
    networks: Object.keys(data.NetworkSettings.Networks ?? {}),
    networkMode: data.HostConfig.NetworkMode ?? "bridge",
    mounts: (data.Mounts ?? []).map((m) => ({
      source: m.Source,
      destination: m.Destination,
      type: m.Type,
    })),
  };
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

export async function stopContainer(id: string): Promise<void> {
  await dockerRequest("POST", `/containers/${id}/stop`);
}

export async function removeContainer(id: string): Promise<void> {
  await dockerRequest("DELETE", `/containers/${id}`);
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export async function getContainerLogs(
  id: string,
  opts?: { tail?: number; since?: string },
): Promise<string> {
  const tail = opts?.tail ?? 100;
  const params = new URLSearchParams({
    stdout: "true",
    stderr: "true",
    tail: String(tail),
  });
  if (opts?.since) {
    params.set("since", opts.since);
  }

  const raw = await dockerRequest<string>("GET", `/containers/${id}/logs?${params.toString()}`);

  // Docker multiplexed stream: each frame has an 8-byte header.
  // Strip the headers to return clean log text.
  if (typeof raw === "string") {
    return stripDockerLogHeaders(raw);
  }
  return "";
}

function stripDockerLogHeaders(raw: string): string {
  // Docker stream protocol: 8-byte header per frame (type[1] + padding[3] + size[4]).
  // For simple cases where the response is already plain text, return as-is.
  // The binary header starts with \x01 (stdout) or \x02 (stderr).
  const firstChar = raw.charCodeAt(0);
  if (firstChar !== 0 && firstChar !== 1 && firstChar !== 2) {
    return raw;
  }

  const lines: string[] = [];
  let offset = 0;
  const buf = Buffer.from(raw, "binary");

  while (offset < buf.length) {
    if (offset + 8 > buf.length) break;
    const frameSize = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + frameSize > buf.length) break;
    lines.push(buf.subarray(offset, offset + frameSize).toString("utf-8"));
    offset += frameSize;
  }

  return lines.join("");
}

// ---------------------------------------------------------------------------
// Port detection
// ---------------------------------------------------------------------------

export async function detectExposedPorts(imageOrId: string): Promise<number[]> {
  // Try image inspect first, fall back to container inspect
  let exposedPorts: Record<string, unknown> | undefined;

  try {
    const image = await dockerRequest<{
      Config?: { ExposedPorts?: Record<string, unknown> };
      ContainerConfig?: { ExposedPorts?: Record<string, unknown> };
    }>("GET", `/images/${encodeURIComponent(imageOrId)}/json`);

    exposedPorts = image.Config?.ExposedPorts ?? image.ContainerConfig?.ExposedPorts;
  } catch {
    // Might be a container ID instead
    const container = await inspectContainer(imageOrId);
    return container.ports.map((p) => p.internal);
  }

  if (!exposedPorts) return [];

  return Object.keys(exposedPorts).map((key) => {
    // key is like "8080/tcp"
    return parseInt(key.split("/")[0], 10);
  });
}

// ---------------------------------------------------------------------------
// Container Stats
// ---------------------------------------------------------------------------

export type ContainerStats = {
  containerId: string;
  containerName: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
  blockRead: number;
  blockWrite: number;
};

/**
 * Get current resource usage stats for a container.
 * Calls the Docker Engine API with stream=false for a single snapshot.
 */
export async function getContainerStats(containerId: string): Promise<ContainerStats> {
  const raw = await dockerRequest<{
    id: string;
    name: string;
    cpu_stats: {
      cpu_usage: { total_usage: number; percpu_usage?: number[] };
      system_cpu_usage: number;
      online_cpus?: number;
    };
    precpu_stats: {
      cpu_usage: { total_usage: number };
      system_cpu_usage: number;
      online_cpus?: number;
    };
    memory_stats: {
      usage: number;
      limit: number;
      stats?: { cache?: number; inactive_file?: number };
    };
    networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
    blkio_stats?: {
      io_service_bytes_recursive?: { op: string; value: number }[] | null;
    };
  }>("GET", `/containers/${containerId}/stats?stream=false`);

  // CPU percentage calculation
  const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
  const systemDelta = raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
  const numCpus = raw.cpu_stats.online_cpus ?? raw.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
  const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

  // Memory (subtract cache/inactive_file for actual working set)
  const cache = raw.memory_stats.stats?.inactive_file ?? raw.memory_stats.stats?.cache ?? 0;
  const memoryUsage = (raw.memory_stats.usage || 0) - cache;
  const memoryLimit = raw.memory_stats.limit || 0;
  const memoryPercent = memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0;

  // Network I/O (sum across all interfaces)
  let networkRx = 0;
  let networkTx = 0;
  if (raw.networks) {
    for (const iface of Object.values(raw.networks)) {
      networkRx += iface.rx_bytes || 0;
      networkTx += iface.tx_bytes || 0;
    }
  }

  // Block I/O
  let blockRead = 0;
  let blockWrite = 0;
  const blkioEntries = raw.blkio_stats?.io_service_bytes_recursive;
  if (blkioEntries) {
    for (const entry of blkioEntries) {
      if (entry.op === "read" || entry.op === "Read") blockRead += entry.value;
      if (entry.op === "write" || entry.op === "Write") blockWrite += entry.value;
    }
  }

  return {
    containerId: raw.id,
    containerName: (raw.name || "").replace(/^\//, ""),
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memoryUsage,
    memoryLimit,
    memoryPercent: Math.round(memoryPercent * 100) / 100,
    networkRx,
    networkTx,
    blockRead,
    blockWrite,
  };
}

/**
 * List all running containers that belong to a project.
 * Uses the `vardo.project` label set during deploy.
 */
export async function getProjectContainers(projectName: string): Promise<ContainerInfo[]> {
  return listContainers(projectName);
}

// ---------------------------------------------------------------------------
// System Disk Usage
// ---------------------------------------------------------------------------

export type DiskUsage = {
  images: { count: number; totalSize: number; reclaimable: number };
  containers: { count: number; totalSize: number };
  volumes: { count: number; totalSize: number };
  buildCache: { count: number; totalSize: number; reclaimable: number };
  total: number;
};

export async function getSystemDiskUsage(): Promise<DiskUsage> {
  const raw = await dockerRequest<{
    Images: { Id: string; Size: number; SharedSize: number }[];
    Containers: { Id: string; SizeRw: number; SizeRootFs: number }[];
    Volumes: { Name: string; UsageData: { Size: number; RefCount: number } }[];
    BuildCache: { ID: string; Size: number; InUse: boolean }[];
  }>("GET", "/system/df");

  const images = {
    count: raw.Images?.length || 0,
    totalSize: raw.Images?.reduce((s, i) => s + (i.Size || 0), 0) || 0,
    reclaimable: raw.Images?.filter((i) => i.SharedSize === i.Size).reduce((s, i) => s + i.Size, 0) || 0,
  };

  const containers = {
    count: raw.Containers?.length || 0,
    totalSize: raw.Containers?.reduce((s, c) => s + (c.SizeRw || 0), 0) || 0,
  };

  const volumes = {
    count: raw.Volumes?.length || 0,
    totalSize: raw.Volumes?.reduce((s, v) => s + (v.UsageData?.Size || 0), 0) || 0,
  };

  const buildCache = {
    count: raw.BuildCache?.length || 0,
    totalSize: raw.BuildCache?.reduce((s, b) => s + (b.Size || 0), 0) || 0,
    reclaimable: raw.BuildCache?.filter((b) => !b.InUse).reduce((s, b) => s + b.Size, 0) || 0,
  };

  return {
    images,
    containers,
    volumes,
    buildCache,
    total: images.totalSize + containers.totalSize + volumes.totalSize + buildCache.totalSize,
  };
}

// ---------------------------------------------------------------------------
// Per-Project Disk Usage
// ---------------------------------------------------------------------------

/**
 * Compute disk usage broken down by project.
 * Uses container labels to map containers and volumes to project names.
 * Returns a Map from project name to total bytes used (containers + volumes).
 */
export async function getPerProjectDiskUsage(): Promise<Map<string, number>> {
  const raw = await dockerRequest<{
    Images: { Id: string; Size: number; SharedSize: number }[];
    Containers: { Id: string; ImageID: string; SizeRw: number; SizeRootFs: number; Labels: Record<string, string> }[];
    Volumes: { Name: string; UsageData: { Size: number; RefCount: number }; Labels: Record<string, string> }[];
    BuildCache: { ID: string; Size: number; InUse: boolean }[];
  }>("GET", "/system/df");

  const byProject = new Map<string, number>();

  // Build image size lookup
  const imageSize = new Map<string, number>();
  for (const img of raw.Images || []) {
    imageSize.set(img.Id, img.Size || 0);
  }

  // Track which images have been attributed to which project (avoid double-counting)
  const imageAttributed = new Map<string, Set<string>>();

  // Containers: writable layer + image size (deduplicated per project)
  for (const c of raw.Containers || []) {
    const project = c.Labels?.["vardo.project"] || c.Labels?.["host.project"];
    if (!project) continue;

    // Container writable layer
    byProject.set(project, (byProject.get(project) || 0) + (c.SizeRw || 0));

    // Image size (only count once per project)
    if (c.ImageID) {
      if (!imageAttributed.has(project)) imageAttributed.set(project, new Set());
      if (!imageAttributed.get(project)!.has(c.ImageID)) {
        imageAttributed.get(project)!.add(c.ImageID);
        const imgSize = imageSize.get(c.ImageID) || 0;
        if (imgSize > 0) {
          byProject.set(project, (byProject.get(project) || 0) + imgSize);
        }
      }
    }
  }

  // Build a map from compose project name -> vardo project name using container labels
  const composeToProject = new Map<string, string>();
  for (const c of raw.Containers || []) {
    const vardoProject = c.Labels?.["vardo.project"] || c.Labels?.["host.project"];
    const composeProject = c.Labels?.["com.docker.compose.project"];
    if (vardoProject && composeProject) {
      composeToProject.set(composeProject, vardoProject);
    }
  }

  // Volumes: match by compose project label, then fall back to name prefix
  for (const v of raw.Volumes || []) {
    const size = v.UsageData?.Size || 0;
    if (size <= 0) continue;

    const composeProject = v.Labels?.["com.docker.compose.project"];
    if (composeProject && composeToProject.has(composeProject)) {
      const project = composeToProject.get(composeProject)!;
      byProject.set(project, (byProject.get(project) || 0) + size);
      continue;
    }

    for (const projectName of new Set(composeToProject.values())) {
      if (v.Name.startsWith(`${projectName}-`) || v.Name.startsWith(`${projectName}_`)) {
        byProject.set(projectName, (byProject.get(projectName) || 0) + size);
        break;
      }
    }
  }

  return byProject;
}

// ---------------------------------------------------------------------------
// System Info
// ---------------------------------------------------------------------------

export type SystemInfo = {
  cpus: number;
  memoryTotal: number;
  os: string;
  kernel: string;
  dockerVersion: string;
  storageDriver: string;
  images: number;
  containers: number;
  containersRunning: number;
};

export async function getSystemInfo(): Promise<SystemInfo> {
  const raw = await dockerRequest<{
    NCPU: number;
    MemTotal: number;
    OperatingSystem: string;
    KernelVersion: string;
    ServerVersion: string;
    Driver: string;
    Images: number;
    Containers: number;
    ContainersRunning: number;
  }>("GET", "/info");

  return {
    cpus: raw.NCPU,
    memoryTotal: raw.MemTotal,
    os: raw.OperatingSystem,
    kernel: raw.KernelVersion,
    dockerVersion: raw.ServerVersion,
    storageDriver: raw.Driver,
    images: raw.Images,
    containers: raw.Containers,
    containersRunning: raw.ContainersRunning,
  };
}
