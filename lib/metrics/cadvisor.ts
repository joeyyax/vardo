const CADVISOR_URL = process.env.CADVISOR_URL || "http://localhost:8081";

export type ContainerMetrics = {
  containerId: string;
  containerName: string;
  projectName: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  diskUsage: number;
  diskLimit: number;
  timestamp: number;
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
};

type V2SpecEntry = {
  aliases: string[];
  labels: Record<string, string>;
  memory?: { limit: number };
};

// Module-level cache for specs (rarely change)
let cachedSpecs: Record<string, V2SpecEntry> | null = null;
let specsCachedAt = 0;
const SPECS_TTL_MS = 60_000; // 60 seconds

/**
 * Fetch metrics for all Docker containers from cAdvisor v2 API.
 */
export async function fetchAllContainerMetrics(): Promise<ContainerMetrics[]> {
  // Always fetch fresh stats
  const statsRes = await fetch(
    `${CADVISOR_URL}/api/v2.0/stats?type=docker&recursive=true&count=2`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!statsRes.ok) throw new Error(`cAdvisor stats returned ${statsRes.status}`);
  const statsData = (await statsRes.json()) as Record<string, V2StatEntry[]>;

  // Only refetch specs if cache is stale or missing
  let specsData: Record<string, V2SpecEntry>;
  if (cachedSpecs && Date.now() - specsCachedAt < SPECS_TTL_MS) {
    specsData = cachedSpecs;
  } else {
    const specsRes = await fetch(
      `${CADVISOR_URL}/api/v2.0/spec?type=docker&recursive=true`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!specsRes.ok) throw new Error(`cAdvisor spec returned ${specsRes.status}`);
    specsData = (await specsRes.json()) as Record<string, V2SpecEntry>;
    cachedSpecs = specsData;
    specsCachedAt = Date.now();
  }

  const metrics: ContainerMetrics[] = [];

  for (const [key, statEntries] of Object.entries(statsData)) {
    if (!statEntries || statEntries.length < 2) continue;

    const spec = specsData[key];
    if (!spec) continue;

    // Get project name from labels
    const projectName =
      spec.labels?.["host.project"] ||
      spec.labels?.["com.docker.compose.project"] ||
      "";
    if (!projectName) continue;

    const prev = statEntries[statEntries.length - 2];
    const curr = statEntries[statEntries.length - 1];

    // CPU: delta-based
    const cpuDelta = curr.cpu.usage.total - prev.cpu.usage.total;
    const timeDelta = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
    const cpuPercent = timeDelta > 0 ? (cpuDelta / (timeDelta * 1e6)) * 100 : 0;

    // Memory
    const memoryUsage = curr.memory.working_set || curr.memory.usage;
    const memoryLimit = spec.memory?.limit || 0;
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

    const containerName = spec.aliases?.[0] || key.split("/").pop() || "";
    const containerId = key.split("/").pop()?.slice(0, 12) || "";

    metrics.push({
      containerId,
      containerName,
      projectName,
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memoryUsage,
      memoryLimit,
      memoryPercent: Math.round(memoryPercent * 100) / 100,
      networkRxBytes,
      networkTxBytes,
      diskUsage,
      diskLimit,
      timestamp: new Date(curr.timestamp).getTime(),
    });
  }

  return metrics;
}

/**
 * Fetch metrics for containers belonging to a specific project.
 */
export async function fetchProjectMetrics(
  projectName: string,
  environmentName?: string,
): Promise<ContainerMetrics[]> {
  const all = await fetchAllContainerMetrics();
  // Container names follow: {project}-{env}-{slot}-{service}-{n}
  // Match by project name prefix, then optionally filter by environment
  const projectContainers = all.filter(
    (m) =>
      m.projectName === projectName ||
      m.projectName.startsWith(`${projectName}-`)
  );
  if (!environmentName) return projectContainers;
  // Filter to containers whose compose project matches {project}-{env}-*
  const envPrefix = `${projectName}-${environmentName}-`;
  return projectContainers.filter(
    (m) => m.containerName.startsWith(envPrefix) || m.projectName.startsWith(envPrefix)
  );
}
