// GPU metrics port interfaces and types.

export type GpuVendor = "nvidia" | "amd" | "intel";

export type GpuDevice = {
  index: number;
  uuid: string;
  name: string; // e.g. "NVIDIA GeForce RTX 3060"
  memoryTotal: number; // bytes
  vendor: GpuVendor;
};

export type GpuDeviceMetrics = {
  device: GpuDevice;
  utilization: number; // 0-100%
  memoryUsed: number; // bytes
  memoryTotal: number; // bytes
  temperature: number; // celsius
  powerDraw: number; // watts
  fanSpeed: number; // 0-100%
};

export type GpuProcess = {
  pid: number;
  deviceIndex: number;
  memoryUsed: number; // bytes
  type: "compute" | "graphics" | "mixed";
};

/** Aggregated GPU metrics for a single container. */
export type ContainerGpuMetrics = {
  containerId: string;
  containerName: string;
  projectName: string;
  organizationId: string | null;
  gpuUtilization: number; // device-level (proportional estimate when shared)
  gpuMemoryUsed: number; // bytes (precise per-process)
  gpuMemoryTotal: number; // bytes (device total)
  gpuTemperature: number; // celsius (device-level)
};

export interface GpuProvider {
  /** Detects available GPUs. Empty when none. */
  detectDevices(): Promise<GpuDevice[]>;

  /** Current metrics for all GPUs. */
  getDeviceMetrics(): Promise<GpuDeviceMetrics[]>;

  /** Processes using GPUs, for PID-to-container mapping. */
  getProcesses(): Promise<GpuProcess[]>;

  readonly vendor: GpuVendor;
}

export interface ContainerResolver {
  /** Maps a host PID to a container ID. Null if not in a container. */
  pidToContainerId(pid: number): Promise<string | null>;

  /** Maps a container ID to app info. Null if unmanaged. */
  containerIdToApp(containerId: string): Promise<{
    projectName: string;
    containerName: string;
    organizationId: string | null;
  } | null>;
}
