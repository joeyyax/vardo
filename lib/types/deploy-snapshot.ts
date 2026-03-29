/**
 * Shape of the config snapshot stored on each successful deployment.
 * Used by the deploy engine (to write), rollback API (to read/restore),
 * and the schema definition (jsonb column type).
 */
export type ConfigSnapshot = {
  cpuLimit: number | null;
  memoryLimit: number | null;
  gpuEnabled: boolean;
  containerPort: number | null;
  imageName: string | null;
  gitBranch: string | null;
  composeFilePath: string | null;
  rootDirectory: string | null;
  restartPolicy: string | null;
  autoTraefikLabels: boolean | null;
  backendProtocol: "http" | "https" | null;
};
