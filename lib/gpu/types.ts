// GPU metrics types.

/** Aggregated GPU metrics for a single container. */
export type ContainerGpuMetrics = {
  containerId: string;
  containerName: string;
  projectName: string;
  organizationId: string | null;
  gpuUtilization: number; // percent; a shared device's split by memory share
  gpuMemoryUsed: number; // bytes
  gpuMemoryTotal: number; // bytes (device total)
  gpuTemperature: number; // celsius (device-level)
};
