import type { ContainerRuntimeOptions } from "./client";

export type ResourceLimits = {
  cpus?: string;
  memory?: string;
  pids?: number | string;
};

export type HealthCheck = {
  test?: string | string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  start_period?: string;
  disable?: boolean;
};

export type Ulimits = Record<string, number | { soft: number; hard: number }>;

/** A service's reference to a top-level `configs:`/`secrets:` entry. */
export type ComposeFileRef =
  | string
  | {
      source: string;
      target?: string;
      uid?: string;
      gid?: string;
      mode?: number;
    };

export type ComposeDependsOnCondition =
  | "service_started"
  | "service_healthy"
  | "service_completed_successfully";

/** depends_on as a list or a condition map. The map form keeps service_healthy gates. */
export type ComposeDependsOn =
  | string[]
  | Record<string, { condition: ComposeDependsOnCondition }>;

/** Service names from either depends_on form. */
export function dependsOnKeys(dependsOn: ComposeDependsOn): string[] {
  return Array.isArray(dependsOn) ? dependsOn : Object.keys(dependsOn);
}

export type ComposeService = {
  name: string;
  image?: string;
  build?: string | { context: string; dockerfile?: string };
  restart?: string;
  ports?: string[];
  expose?: string[];
  environment?: Record<string, string>;
  env_file?: string[];
  volumes?: string[];
  labels?: Record<string, string>;
  networks?: string[];
  depends_on?: ComposeDependsOn;
  network_mode?: string;
  runtime?: string;
  deploy?: {
    resources?: {
      limits?: ResourceLimits;
      reservations?: {
        memory?: string;
        devices?: Array<{
          driver?: string;
          count?: number | string;
          capabilities?: string[];
        }>;
      };
    };
  };
  // QoS tier fields injected by the Vardo overlay.
  oom_score_adj?: number;
  mem_reservation?: string;
  /** Swap ceiling beside the memory limit; `-1` is unlimited swap. */
  memswap_limit?: string | number;
  cpu_shares?: number;
  // Extended fields for container import round-trip.
  cap_add?: string[];
  cap_drop?: string[];
  devices?: string[];
  privileged?: boolean;
  security_opt?: string[];
  shm_size?: string;
  init?: boolean;
  extra_hosts?: string[];
  healthcheck?: HealthCheck;
  ulimits?: Ulimits;
  hostname?: string;
  user?: string;
  stop_signal?: string;
  entrypoint?: string | string[];
  command?: string | string[];
  tmpfs?: string[];
  /** Supplementary groups, e.g. the docker group for socket access. */
  group_add?: string[];
  /** Fixed container name. Honored only on a shared service; two slots can't share a name. */
  container_name?: string;
  read_only?: boolean;
  stdin_open?: boolean;
  tty?: boolean;
  working_dir?: string;
  /** Upstream resolvers. Docker keeps its embedded DNS on user-defined networks. */
  dns?: string[];
  dns_search?: string[];
  dns_opt?: string[];
  sysctls?: Record<string, string | number> | string[];
  pull_policy?: string;
  stop_grace_period?: string;
  /** Config files mounted into the container, defined under top-level `configs:`. */
  configs?: ComposeFileRef[];
  /** Secret files mounted into the container, defined under top-level `secrets:`. */
  secrets?: ComposeFileRef[];
  /** Opt this service out of blue/green — see lib/docker/slot-partition.ts. */
  "x-vardo-shared"?: boolean;
};

export type ComposeFile = {
  /** Top-level `name:`. Pins the shared project — see lib/docker/slot-partition.ts. */
  name?: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
  configs?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
};

export type PortMapping = {
  serviceName: string;
  internal: number;
  external?: number;
};

export type ContainerConfig = {
  image: string;
  ports: { internal: number; external?: number; protocol: string }[];
  mounts: { name: string; source: string; destination: string; type: string }[];
  networkMode: string;
  labels: Record<string, string>;
  hasEnvVars: boolean;
} & ContainerRuntimeOptions;

export type DeployTransformDomain = {
  id: string;
  domain: string;
  port: number | null;
  sslEnabled: boolean | null;
  certResolver: string | null;
  redirectTo: string | null;
  redirectCode: number | null;
  /** Compose service this domain routes to. Null means the primary service. */
  serviceName?: string | null;
  pathPrefix?: string | null;
  stripPathPrefix?: boolean | null;
  /** Comma-separated Traefik middleware references. */
  middlewares?: string | null;
};

export type ComposePreviewApp = {
  name: string;
  deployType: string;
  imageName: string | null;
  composeContent: string | null;
  containerPort: number | null;
  cpuLimit: number | null;
  memoryLimit: number | null;
  gpuEnabled: boolean;
  exposedPorts: { internal: number; external?: number; protocol?: string }[] | null;
  domains: DeployTransformDomain[];
  backendProtocol?: "http" | "https" | null;
  securityHeaders?: boolean;
};

export type ValidateOptions = {
  allowBindMounts?: boolean;
  /** Permit mounting the Docker socket; the rest of the mount deny-list stays enforced. (#744) */
  allowDockerSocket?: boolean;
  /** Skip all mount-related validation checks for trusted orgs. */
  skipMountChecks?: boolean;
};

/** Per-service deploy config from decomposed child app rows, keyed by compose service name. (#745) */
export type ServiceConfigOverride = {
  cpuLimit: number | null;
  memoryLimit: number | null;
  gpuEnabled: boolean;
  /** Resolved QoS tier: the child's priority, else the parent's. Null means "standard". */
  priority: "critical" | "standard" | "disposable" | null;
};
