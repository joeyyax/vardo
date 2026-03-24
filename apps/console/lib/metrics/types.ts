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
};

/** SSE event payload — point + optional container breakdown */
export type MetricsStreamEvent = MetricsPoint & {
  containers?: ContainerPoint[];
};
