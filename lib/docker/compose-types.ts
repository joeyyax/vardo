// ---------------------------------------------------------------------------
// Docker Compose type definitions for Vardo projects.
// ---------------------------------------------------------------------------

import type { ContainerRuntimeOptions } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResourceLimits = {
  cpus?: string;
  memory?: string;
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

export type ComposeDependsOnCondition =
  | "service_started"
  | "service_healthy"
  | "service_completed_successfully";

/**
 * Docker Compose depends_on can be a simple list of service names or an object
 * mapping service names to their dependency conditions. Using the object form
 * preserves health-check gates (service_healthy) that are lost in the string[]
 * form.
 */
export type ComposeDependsOn =
  | string[]
  | Record<string, { condition: ComposeDependsOnCondition }>;

/**
 * Extract the service name keys from a ComposeDependsOn value, normalising
 * both the string[] and object forms.
 */
export function dependsOnKeys(dependsOn: ComposeDependsOn): string[] {
  return Array.isArray(dependsOn) ? dependsOn : Object.keys(dependsOn);
}

export type ComposeService = {
  name: string;
  image?: string;
  build?: string | { context: string; dockerfile?: string };
  restart?: string;
  ports?: string[];
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
        devices?: Array<{
          driver?: string;
          count?: number | string;
          capabilities?: string[];
        }>;
      };
    };
  };
  // Extended fields for faithful container import/round-trip
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
};

export type ComposeFile = {
  services: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
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
  /**
   * Compose service this domain should route to. Set when the domain is
   * attached to a child app of a multi-service compose app — the deploy
   * pipeline injects Traefik labels for this specific service so multiple
   * services in the same compose can carry distinct ingress rules.
   * Null = "primary service" (legacy behavior, used for parent-app domains).
   */
  composeService?: string | null;
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
};

export type ValidateOptions = {
  allowBindMounts?: boolean;
  /** Skip all mount-related validation checks. Used when the org is trusted. */
  skipMountChecks?: boolean;
};
