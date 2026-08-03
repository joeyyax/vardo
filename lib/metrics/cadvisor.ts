import type { MetricsProvider } from "./provider";
import type { ContainerMetrics } from "./types";

const CADVISOR_URL = process.env.CADVISOR_URL || "http://cadvisor:8080";

type V2Accelerator = {
  id: string;
  make: string;
  model: string;
  memory: number;       // total GPU memory in bytes
  duty_cycle: number;   // GPU utilization %
  memory_used: number;  // GPU memory used in bytes
  temperature: number;  // Celsius
};

type V2StatEntry = {
  timestamp: string;
  has_cpu: boolean;
  cpu: { usage: { total: number } };
  has_memory: boolean;
  memory: { usage: number; working_set: number };
  has_network: boolean;
  network?: {
    interfaces?: { name: string; rx_bytes: number; tx_bytes: number }[];
  };
  has_filesystem: boolean;
  filesystem?: { device: string; usage: number; capacity: number }[];
  has_diskio: boolean;
  diskio?: {
    io_service_bytes?: { device: string; major: number; minor: number; stats: Record<string, number> }[];
  };
  has_accelerators?: boolean;
  accelerators?: V2Accelerator[];
};

type V2SpecEntry = {
  aliases: string[];
  labels: Record<string, string>;
  memory?: { limit: number };
};

const SPECS_TTL_MS = 60_000; // 60 seconds

// Per-URL spec cache — keyed by base URL to avoid stale data on provider swap
const specsCacheByUrl = new Map<string, { specs: Record<string, V2SpecEntry>; cachedAt: number }>();

/**
 * Short container id from a cAdvisor cgroup path. Keys are `/docker/<id>` on
 * cgroup v1 and `/system.slice/docker-<id>.scope` under systemd, so taking the
 * last path segment yields "docker-abcde" on any modern host.
 */
export function parseContainerId(cgroupPath: string): string {
  const hex = parseFullContainerId(cgroupPath);
  if (hex) return hex.slice(0, 12);
  return cgroupPath.split("/").pop()?.replace(/^docker[-/]/, "").slice(0, 12) ?? "";
}

/** Full 64-char container id from a cAdvisor cgroup path; empty when it carries none. */
export function parseFullContainerId(cgroupPath: string): string {
  return cgroupPath.match(/([0-9a-f]{64})/i)?.[1] ?? "";
}

/**
 * Label prefixes app matching reads. cAdvisor's spec endpoint returns every
 * Docker label; Traefik rules and OCI annotations are dropped here so the
 * snapshot held in memory stays small.
 */
const IDENTITY_LABEL_PREFIXES = ["vardo.", "host.", "com.docker.compose."];

function identityLabels(labels: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (IDENTITY_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix))) out[key] = value;
  }
  return out;
}

/**
 * Fetch metrics for all Docker containers from cAdvisor v2 API.
 */
export async function fetchAllContainerMetrics(baseUrl = CADVISOR_URL): Promise<ContainerMetrics[]> {
  // Always fetch fresh stats
  const statsRes = await fetch(
    `${baseUrl}/api/v2.0/stats?type=docker&recursive=true&count=2`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!statsRes.ok) throw new Error(`cAdvisor stats returned ${statsRes.status}`);
  const statsData = (await statsRes.json()) as Record<string, V2StatEntry[]>;

  // Only refetch specs if cache is stale or missing (keyed per URL)
  let specsData: Record<string, V2SpecEntry>;
  const cached = specsCacheByUrl.get(baseUrl);
  if (cached && Date.now() - cached.cachedAt < SPECS_TTL_MS) {
    specsData = cached.specs;
  } else {
    const specsRes = await fetch(
      `${baseUrl}/api/v2.0/spec?type=docker&recursive=true`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!specsRes.ok) throw new Error(`cAdvisor spec returned ${specsRes.status}`);
    specsData = (await specsRes.json()) as Record<string, V2SpecEntry>;
    specsCacheByUrl.set(baseUrl, { specs: specsData, cachedAt: Date.now() });
  }

  const metrics: ContainerMetrics[] = [];

  for (const [key, statEntries] of Object.entries(statsData)) {
    if (!statEntries || statEntries.length < 2) continue;

    const spec = specsData[key];
    if (!spec) continue;

    // Get project name and org from labels
    const projectName =
      spec.labels?.["vardo.project"] ||
      spec.labels?.["host.project"] ||
      spec.labels?.["com.docker.compose.project"] ||
      "";
    if (!projectName) continue;

    const organizationId = spec.labels?.["vardo.organization"] || spec.labels?.["host.organization"] || null;

    const prev = statEntries[statEntries.length - 2];
    const curr = statEntries[statEntries.length - 1];

    // CPU: delta-based
    const cpuDelta = curr.cpu.usage.total - prev.cpu.usage.total;
    const timeDelta = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
    const cpuPercent = timeDelta > 0 ? (cpuDelta / (timeDelta * 1e6)) * 100 : 0;

    // Memory
    const memoryUsage = curr.memory.working_set || curr.memory.usage;
    // cAdvisor reports max uint64 when no memory limit is set — treat as 0 (unlimited)
    const rawLimit = spec.memory?.limit || 0;
    const memoryLimit = rawLimit > 1e15 ? 0 : rawLimit;
    const memoryPercent = memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0;

    // Network
    let networkRxBytes = 0;
    let networkTxBytes = 0;
    if (curr.network?.interfaces) {
      for (const iface of curr.network.interfaces) {
        networkRxBytes += iface.rx_bytes;
        networkTxBytes += iface.tx_bytes;
      }
    }

    // Filesystem
    let diskUsage = 0;
    let diskLimit = 0;
    if (curr.filesystem) {
      for (const fs of curr.filesystem) {
        diskUsage += fs.usage || 0;
        diskLimit += fs.capacity || 0;
      }
    }

    // Disk I/O writes (cumulative)
    let diskWriteBytes = 0;
    if (curr.diskio?.io_service_bytes) {
      for (const dev of curr.diskio.io_service_bytes) {
        diskWriteBytes += dev.stats?.Write || 0;
      }
    }

    // GPU accelerators (NVIDIA via cAdvisor NVML integration)
    let gpuUtilization = 0;
    let gpuMemoryUsed = 0;
    let gpuMemoryTotal = 0;
    let gpuTemperature = 0;
    if (curr.has_accelerators && curr.accelerators && curr.accelerators.length > 0) {
      for (const acc of curr.accelerators) {
        gpuUtilization += acc.duty_cycle || 0;
        gpuMemoryUsed += acc.memory_used || 0;
        gpuMemoryTotal += acc.memory || 0;
        gpuTemperature += acc.temperature || 0;
      }
      // Average temperature across GPUs
      gpuTemperature = Math.round(gpuTemperature / curr.accelerators.length);
    }

    const containerName = spec.aliases?.[0] || key.split("/").pop() || "";
    const containerId = parseContainerId(key);

    metrics.push({
      containerId,
      containerIdFull: parseFullContainerId(key),
      containerName,
      projectName,
      organizationId,
      labels: identityLabels(spec.labels),
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memoryUsage,
      memoryLimit,
      memoryPercent: Math.round(memoryPercent * 100) / 100,
      networkRxBytes,
      networkTxBytes,
      diskUsage,
      diskLimit,
      diskWriteBytes,
      gpuUtilization: Math.round(gpuUtilization * 100) / 100,
      gpuMemoryUsed,
      gpuMemoryTotal,
      gpuTemperature,
      timestamp: new Date(curr.timestamp).getTime(),
    });
  }

  return metrics;
}

/**
 * cAdvisor metrics provider — implements MetricsProvider interface.
 * Optionally accepts a URL override (for integration-configured instances).
 */
export class CadvisorProvider implements MetricsProvider {
  private url: string;

  constructor(url?: string) {
    this.url = url ?? CADVISOR_URL;
  }

  async fetchAll(): Promise<ContainerMetrics[]> {
    return fetchAllContainerMetrics(this.url);
  }
}
