/** Config snapshot stored on each successful deployment, used for rollback. */
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
  /** Compose content for direct-source apps. Absent on older snapshots. */
  composeContent?: string | null;
  /** Pinned `repo@sha256:...` ref for image apps, so rollback restores the exact image. */
  imageDigest?: string | null;
  /** Engine major per major-locked service, keyed by compose service ("" when single-image). */
  imageMajors?: Record<string, number>;
};
