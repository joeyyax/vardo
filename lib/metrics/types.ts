export type ContainerMetrics = {
  /** 12-char id — the form metric keys are stored under. */
  containerId: string;
  /** Full 64-char Docker id, empty when the cgroup path carries none. */
  containerIdFull: string;
  containerName: string;
  projectName: string;
  organizationId: string | null;
  /** Vardo, host and compose labels — what app matching joins on. */
  labels: Record<string, string>;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  /** Container filesystem bytes. Null when cAdvisor reports no filesystem stats. */
  diskUsage: number | null;
  diskLimit: number | null;
  /** Cumulative block I/O writes. Null when cAdvisor reports no io_service_bytes. */
  diskWriteBytes: number | null;
  gpuUtilization: number; // percent (summed duty_cycle across accelerators)
  gpuMemoryUsed: number; // bytes
  gpuMemoryTotal: number; // bytes
  gpuTemperature: number; // Celsius (average across accelerators)
  timestamp: number;
};

/** Unified metrics data point — same shape for historical and live */
export type MetricsPoint = {
  timestamp: number; // ms epoch
  cpu: number; // percent (summed across containers)
  memory: number; // bytes
  memoryLimit: number; // bytes (max across containers)
  networkRx: number; // bytes
  networkTx: number; // bytes
  diskTotal: number; // bytes
  gpuUtilization: number; // percent (averaged across GPU containers)
  gpuMemoryUsed: number; // bytes
  gpuMemoryTotal: number; // bytes
  gpuTemperature: number; // Celsius (average)
};

/** Per-container snapshot for detail tables */
export type ContainerPoint = {
  containerId: string;
  containerName: string;
  /** Compose service, when the container carries the label. */
  composeService: string | null;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
  gpuUtilization: number;
  gpuMemoryUsed: number;
  gpuMemoryTotal: number;
  gpuTemperature: number;
};

/** SSE event payload — point + optional container breakdown */
export type MetricsStreamEvent = MetricsPoint & {
  containers?: ContainerPoint[];
};
