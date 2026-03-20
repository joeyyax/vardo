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
