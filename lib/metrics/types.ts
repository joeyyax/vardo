export type ContainerMetrics = {
  containerId: string;
  containerName: string;
  projectName: string;
  organizationId: string | null;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  diskUsage: number;
  diskLimit: number;
  diskWriteBytes: number; // cumulative block I/O writes
  gpuUtilization: number; // percent (summed duty_cycle across accelerators)
  gpuMemoryUsed: number; // bytes
  gpuMemoryTotal: number; // bytes
  gpuTemperature: number; // Celsius (average across accelerators)
  timestamp: number;
};

export type ContainerStatsSnapshot = {
  containerId: string;
  containerName: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
};

export type TimePoint = {
  time: string;
  timestamp: number;
  cpu: number;
  memory: number;
  networkRx: number;
  networkTx: number;
  diskTotal: number;
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
