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

type CAdvisorStats = {
  timestamp: string;
  cpu: {
    usage: { total: number };
  };
  memory: {
    usage: number;
    working_set: number;
    hierarchical_data?: { pgfault: number; pgmajfault: number };
  };
  network?: {
    interfaces?: { name: string; rx_bytes: number; tx_bytes: number }[];
  };
  filesystem?: { device: string; usage: number; capacity: number }[];
};

type CAdvisorContainer = {
  id: string;
  name: string;
  aliases: string[];
  labels: Record<string, string>;
  stats: CAdvisorStats[];
  spec: {
    has_cpu: boolean;
    has_memory: boolean;
    memory?: { limit: number };
    cpu?: { limit: number };
  };
};

/**
 * Fetch metrics for all Docker containers from cAdvisor.
 * Returns parsed metrics with project name extracted from container labels.
 */
export async function fetchAllContainerMetrics(): Promise<ContainerMetrics[]> {
  const res = await fetch(`${CADVISOR_URL}/api/v2.0/stats?type=docker&count=2`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`cAdvisor returned ${res.status}`);
  }

  const data = (await res.json()) as Record<string, CAdvisorContainer>;
  const metrics: ContainerMetrics[] = [];

  for (const [, container] of Object.entries(data)) {
    const stats = container.stats;
    if (!stats || stats.length < 2) continue;

    const projectName =
      container.labels?.["com.docker.compose.project"] ||
      container.labels?.["host.project"] ||
      "";

    if (!projectName) continue;

    const prev = stats[stats.length - 2];
    const curr = stats[stats.length - 1];

    // CPU: delta-based calculation
    const cpuDelta = curr.cpu.usage.total - prev.cpu.usage.total;
    const timeDelta =
      new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
    const cpuPercent = timeDelta > 0 ? (cpuDelta / (timeDelta * 1e6)) * 100 : 0;

    // Memory
    const memoryUsage = curr.memory.working_set || curr.memory.usage;
    const memoryLimit = container.spec.memory?.limit || 0;
    const memoryPercent =
      memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0;

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

    // Clean container name (remove leading /)
    const containerName = container.aliases?.[0] || container.name || container.id;

    metrics.push({
      containerId: container.id.slice(0, 12),
      containerName: containerName.replace(/^\//, ""),
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
  projectName: string
): Promise<ContainerMetrics[]> {
  const all = await fetchAllContainerMetrics();
  return all.filter(
    (m) =>
      m.projectName === projectName ||
      m.projectName.startsWith(`${projectName}-`) // blue/green slots
  );
}
