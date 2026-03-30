// ---------------------------------------------------------------------------
// Docker Compose generation and manipulation for Vardo projects.
//
// NOTE: This module includes a minimal YAML serializer/parser sufficient for
// Docker Compose files. For production hardening, install `yaml` or `js-yaml`
// and swap the implementations of `composeToYaml` and `parseCompose`.
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
  depends_on?: string[];
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

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generate a ComposeFile for a single-image project.
 * The service name is derived from the project name.
 */
export function generateComposeForImage(opts: {
  projectName: string;
  imageName: string;
  containerPort?: number;
  envVars?: Record<string, string>;
  volumes?: { name: string; mountPath: string }[];
  exposedPorts?: { internal: number; external?: number; protocol?: string }[];
}): ComposeFile {
  const { projectName, imageName, containerPort, envVars, volumes, exposedPorts } = opts;

  const service: ComposeService = {
    name: projectName,
    image: imageName,
    restart: "unless-stopped",
  };

  // Map exposed ports to host (for non-HTTP services like databases)
  if (exposedPorts && exposedPorts.length > 0) {
    service.ports = exposedPorts
      .filter((p) => p.external)
      .map((p) => `${p.external}:${p.internal}${p.protocol ? `/${p.protocol}` : ""}`);
  }

  // Env vars are written to .env file and loaded via env_file directive.
  // Do NOT inline them in the compose environment block — Docker Compose
  // interprets ${} as its own variable interpolation and chokes on our
  // template expressions before we can resolve them.
  if (envVars && Object.keys(envVars).length > 0) {
    service.env_file = [".env"];
  }

  if (volumes && volumes.length > 0) {
    service.volumes = volumes.map((v) => `${v.name}:${v.mountPath}`);
  }

  const compose: ComposeFile = {
    services: {
      [projectName]: service,
    },
  };

  // Declare named volumes at top level
  if (volumes && volumes.length > 0) {
    compose.volumes = {};
    for (const v of volumes) {
      compose.volumes[v.name] = {};
    }
  }

  return compose;
}

// ---------------------------------------------------------------------------
// Helpers for container spec conversion
// ---------------------------------------------------------------------------

/**
 * Convert a byte count to a compact size string.
 * Uses exact multiples only to avoid rounding drift on round-trip.
 */
function bytesToSizeString(bytes: number): string {
  const GiB = 1024 * 1024 * 1024;
  const MiB = 1024 * 1024;
  const KiB = 1024;
  if (bytes % GiB === 0) return `${bytes / GiB}g`;
  if (bytes % MiB === 0) return `${bytes / MiB}m`;
  if (bytes % KiB === 0) return `${bytes / KiB}k`;
  return `${bytes}b`;
}

/**
 * Convert Docker's nanosecond duration to a compose-compatible duration string.
 */
export function nanosToDuration(nanos: number): string {
  const ms = nanos / 1e6;
  const s = ms / 1000;
  const m = s / 60;
  if (Number.isInteger(m) && m >= 1) return `${m}m`;
  if (Number.isInteger(s) && s >= 1) return `${s}s`;
  if (Number.isInteger(ms) && ms >= 1) return `${ms}ms`;
  return `${Math.round(s)}s`;
}

// ---------------------------------------------------------------------------
// Import-from-container compose generation
// ---------------------------------------------------------------------------

export type ContainerConfig = {
  image: string;
  ports: { internal: number; external?: number; protocol: string }[];
  mounts: { name: string; source: string; destination: string; type: string }[];
  networkMode: string;
  labels: Record<string, string>;
  hasEnvVars: boolean;
} & ContainerRuntimeOptions;

/**
 * Narrow an arbitrary string DB value to the valid backend protocol union.
 * Drizzle types text columns as string | null; this helper validates the
 * value at runtime and returns null for anything unexpected, avoiding
 * scattered `as "http" | "https" | null` casts at every call site.
 */
export function narrowBackendProtocol(
  value: string | null | undefined,
): "http" | "https" | null {
  if (value === "http" || value === "https") return value;
  return null;
}

/**
 * Resolve the effective backend protocol Traefik should use when connecting to
 * the container. Explicit "http"/"https" always wins; null/undefined triggers
 * auto-detection based on the container port (443 or 8443 → https).
 */
export function resolveBackendProtocol(
  backendProtocol: "http" | "https" | null | undefined,
  port: number,
): "http" | "https" {
  if (backendProtocol === "https") return "https";
  if (backendProtocol === "http") return "http";
  return port === 443 || port === 8443 ? "https" : "http";
}

// Only labels with these prefixes survive the import filter. Everything else
// (OCI image metadata, Docker Compose internals, arbitrary user labels) is
// stripped so the generated compose stays clean. Traefik routing labels are
// allowed through because they may carry custom middleware config; Vardo labels
// are allowed so any user-set vardo.* metadata is preserved. Both will be
// re-evaluated and overwritten during deploy anyway.
export const TRAEFIK_LABEL_PREFIX = "traefik.";
const ALLOWED_LABEL_PREFIXES = [TRAEFIK_LABEL_PREFIX, "vardo."];

/**
 * Generate a ComposeFile from a captured container spec.
 * Faithfully reproduces capabilities, resource limits, network mode, devices,
 * healthcheck, and all other Docker options present on the original container.
 *
 * Named volumes are declared at the top level; bind mounts are included
 * as-is (the caller controls which mounts to include).
 */
export function generateComposeFromContainer(
  serviceName: string,
  container: ContainerConfig,
): ComposeFile {
  const service: ComposeService = {
    name: serviceName,
    image: container.image,
  };

  // Restart policy: default to unless-stopped if the container had none/no.
  const restart =
    container.restartPolicy && container.restartPolicy !== "no"
      ? container.restartPolicy
      : "unless-stopped";
  service.restart = restart;

  // Ports: only include mappings that exposed a host port.
  const externalPorts = container.ports.filter((p) => p.external);
  if (externalPorts.length > 0) {
    service.ports = externalPorts.map((p) => {
      const proto = p.protocol && p.protocol !== "tcp" ? `/${p.protocol}` : "";
      return `${p.external}:${p.internal}${proto}`;
    });
  }

  // Env file (written separately during deploy).
  if (container.hasEnvVars) {
    service.env_file = [".env"];
  }

  // Volumes.
  // Anonymous volumes have a 64-char hex name assigned by Docker — they should
  // be emitted as a bare container path so Docker Compose recreates an anonymous
  // volume on deploy rather than trying to reference a named volume.
  // An empty name is also treated as anonymous (defensive: shouldn't happen with Docker).
  const dockerVolumes = container.mounts.filter((m) => m.type === "volume");
  const namedVolumes = dockerVolumes.filter((m) => !isAnonymousVolume(m.name));
  const anonymousVolumes = dockerVolumes.filter((m) => isAnonymousVolume(m.name));
  const bindMounts = container.mounts.filter((m) => m.type === "bind");
  const allMounts = [
    ...namedVolumes.map((m) => `${m.name}:${m.destination}`),
    ...anonymousVolumes.map((m) => m.destination),
    ...bindMounts.map((m) => `${m.source}:${m.destination}`),
  ];
  if (allMounts.length > 0) service.volumes = allMounts;

  // Network mode.
  // Special modes (host, none, container:, service:) must be preserved as
  // network_mode — they change the network namespace, not just membership.
  // Named Docker networks should go in the networks array instead: setting
  // them as network_mode causes injectNetwork to skip the service, so it
  // never joins vardo-network and cross-service DNS breaks.
  if (container.networkMode) {
    const isSpecialMode =
      container.networkMode === "host" ||
      container.networkMode === "none" ||
      container.networkMode.startsWith("container:") ||
      container.networkMode.startsWith("service:");

    if (isSpecialMode) {
      service.network_mode = container.networkMode;
    } else if (
      container.networkMode !== "bridge" &&
      container.networkMode !== "default"
    ) {
      // Named Docker network — add to the networks array so injectNetwork can
      // still attach vardo-network alongside it.
      service.networks = [container.networkMode];
    }
  }

  // Labels: keep only traefik. and vardo. prefixed labels. OCI image metadata
  // (maintainer, org.opencontainers.image.*), Docker Compose internals, and
  // everything else is stripped — they belong to the image or the runtime, not
  // the compose definition.
  const filteredLabels = Object.fromEntries(
    Object.entries(container.labels).filter(
      ([k]) => ALLOWED_LABEL_PREFIXES.some((prefix) => k.startsWith(prefix))
    )
  );
  if (Object.keys(filteredLabels).length > 0) service.labels = filteredLabels;

  // Capabilities.
  if (container.capAdd.length > 0) service.cap_add = container.capAdd;
  if (container.capDrop.length > 0) service.cap_drop = container.capDrop;

  // Devices.
  if (container.devices.length > 0) {
    service.devices = container.devices.map((d) => {
      const perms =
        d.permissions && d.permissions !== "rwm" ? `:${d.permissions}` : "";
      return `${d.hostPath}:${d.containerPath}${perms}`;
    });
  }

  // Privileged mode.
  if (container.privileged) service.privileged = true;

  // Security options.
  if (container.securityOpt.length > 0) service.security_opt = container.securityOpt;

  // Shared memory size (skip the 64 MiB Docker default to keep the compose clean).
  const DEFAULT_SHM_SIZE = 64 * 1024 * 1024;
  if (container.shmSize > 0 && container.shmSize !== DEFAULT_SHM_SIZE) {
    service.shm_size = bytesToSizeString(container.shmSize);
  }

  // Init process.
  if (container.init) service.init = true;

  // Extra hosts (/etc/hosts entries).
  if (container.extraHosts.length > 0) service.extra_hosts = container.extraHosts;

  // Resource limits from HostConfig (cpu/memory).
  if (container.nanoCpus > 0 || container.memoryBytes > 0) {
    const limits: ResourceLimits = {};
    if (container.nanoCpus > 0) limits.cpus = String(container.nanoCpus / 1e9);
    if (container.memoryBytes > 0) limits.memory = bytesToSizeString(container.memoryBytes);
    service.deploy = { resources: { limits } };
  }

  // Ulimits.
  if (container.ulimits.length > 0) {
    const ulimits: Ulimits = {};
    for (const u of container.ulimits) {
      ulimits[u.name] =
        u.soft === u.hard ? u.soft : { soft: u.soft, hard: u.hard };
    }
    service.ulimits = ulimits;
  }

  // Tmpfs mounts.
  if (container.tmpfs.length > 0) service.tmpfs = container.tmpfs;

  // Hostname: skip if it looks like the Docker-assigned short container ID
  // (12 lowercase hex chars) since that would conflict on redeploy.
  if (container.hostname && !/^[a-f0-9]{12}$/.test(container.hostname)) {
    service.hostname = container.hostname;
  }

  // User.
  if (container.user) service.user = container.user;

  // Stop signal (SIGTERM is the default; omit to keep the compose clean).
  if (container.stopSignal && container.stopSignal !== "SIGTERM") {
    service.stop_signal = container.stopSignal;
  }

  // Healthcheck.
  if (container.healthcheck) {
    const hc = container.healthcheck;
    const spec: HealthCheck = { test: hc.test };
    if (hc.interval > 0) spec.interval = nanosToDuration(hc.interval);
    if (hc.timeout > 0) spec.timeout = nanosToDuration(hc.timeout);
    if (hc.retries > 0) spec.retries = hc.retries;
    if (hc.startPeriod > 0) spec.start_period = nanosToDuration(hc.startPeriod);
    service.healthcheck = spec;
  }

  // Entrypoint.
  if (container.entrypoint.length > 0) service.entrypoint = container.entrypoint;

  // Command.
  if (container.command.length > 0) service.command = container.command;

  const compose: ComposeFile = {
    services: { [serviceName]: service },
  };

  // Declare named volumes at the top level.
  if (namedVolumes.length > 0) {
    compose.volumes = {};
    for (const v of namedVolumes) {
      compose.volumes[v.name] = {};
    }
  }

  // Declare any named Docker networks as external so compose knows they
  // pre-exist and does not try to create them.
  if (service.networks && service.networks.length > 0) {
    compose.networks = {};
    for (const net of service.networks) {
      compose.networks[net] = { external: true };
    }
  }

  return compose;
}

// ---------------------------------------------------------------------------
// Traefik label injection
// ---------------------------------------------------------------------------

/**
 * Add Traefik reverse-proxy labels to a service in the compose file.
 * Returns a new ComposeFile -- does not mutate the original.
 */
export function injectTraefikLabels(
  compose: ComposeFile,
  opts: {
    projectName: string;
    domain: string;
    containerPort: number;
    serviceName?: string;
    appName?: string;
    certResolver?: string;
    ssl?: boolean;
    redirectTo?: string;
    redirectCode?: number;
    backendProtocol?: "http" | "https";
  },
): ComposeFile {
  const { projectName, domain, containerPort, certResolver = "le", ssl = true } = opts;
  const serviceName =
    opts.serviceName ?? Object.keys(compose.services)[0];

  if (!serviceName || !compose.services[serviceName]) {
    throw new Error(
      `Service "${serviceName}" not found in compose file. Available: ${Object.keys(compose.services).join(", ")}`,
    );
  }

  const existing = compose.services[serviceName];
  const isLocal = domain.endsWith(".localhost") || domain === "localhost";
  const isRedirect = !!opts.redirectTo;
  const permanent = (opts.redirectCode ?? 301) === 301;

  const labels: Record<string, string> = {
    ...existing.labels,
    "traefik.enable": "true",
    [`traefik.http.routers.${projectName}.rule`]: `Host(\`${domain}\`)`,
  };

  if (isRedirect) {
    // Redirect domain — use redirectregex middleware instead of routing to the app service.
    // The router still needs TLS termination so Traefik can serve the redirect over HTTPS.
    labels[`traefik.http.middlewares.${projectName}-redirect.redirectregex.regex`] = "^https?://[^/]+(.*)$";
    labels[`traefik.http.middlewares.${projectName}-redirect.redirectregex.replacement`] = `${opts.redirectTo}\${1}`;
    labels[`traefik.http.middlewares.${projectName}-redirect.redirectregex.permanent`] = String(permanent);
    labels[`traefik.http.routers.${projectName}.middlewares`] = `${projectName}-redirect`;
    // Redirect routers still need a service reference — point to the app's shared service
    labels[`traefik.http.routers.${projectName}.service`] = opts.appName || projectName;
  } else {
    // Normal domain — route to the app container
    const svcName = opts.appName || projectName;
    labels[`traefik.http.services.${svcName}.loadbalancer.server.port`] = String(containerPort);
    labels[`traefik.http.routers.${projectName}.service`] = svcName;
    if (opts.backendProtocol === "https") {
      labels[`traefik.http.services.${svcName}.loadbalancer.server.scheme`] = "https";
      labels[`traefik.http.services.${svcName}.loadbalancer.serversTransport`] = `${svcName}-insecure@file`;
    }
  }

  if (ssl) {
    // HTTPS — websecure entrypoint with TLS
    labels[`traefik.http.routers.${projectName}.entrypoints`] = "websecure";
    labels[`traefik.http.routers.${projectName}.tls`] = "true";

    // Production: use cert resolver (Let's Encrypt / Google)
    // Local: Traefik auto-generates self-signed certs
    if (!isLocal) {
      labels[`traefik.http.routers.${projectName}.tls.certresolver`] = certResolver;
    }

    // HTTP redirect router — catches port-80 traffic and sends it to HTTPS
    // (or to the domain redirect target, if this is a redirect domain).
    labels[`traefik.http.routers.${projectName}-http.rule`] = `Host(\`${domain}\`)`;
    labels[`traefik.http.routers.${projectName}-http.entrypoints`] = "web";
    labels[`traefik.http.routers.${projectName}-http.service`] = opts.appName || projectName;

    if (isRedirect) {
      // For redirect domains, the HTTP router also applies the domain redirect
      labels[`traefik.http.routers.${projectName}-http.middlewares`] = `${projectName}-redirect`;
    } else {
      labels[`traefik.http.middlewares.${projectName}-https-redirect.redirectscheme.scheme`] = "https";
      labels[`traefik.http.middlewares.${projectName}-https-redirect.redirectscheme.permanent`] = "true";
      labels[`traefik.http.routers.${projectName}-http.middlewares`] = `${projectName}-https-redirect`;
    }
  } else {
    // HTTP only — web entrypoint, no TLS
    labels[`traefik.http.routers.${projectName}.entrypoints`] = "web";
    if (isRedirect) {
      labels[`traefik.http.routers.${projectName}.middlewares`] = `${projectName}-redirect`;
    }
  }

  // Remove host port bindings — Traefik handles external access
  // Keep only the internal port exposure for Docker networking
  const updatedService: ComposeService = {
    ...existing,
    labels,
    ports: undefined,
  };

  return {
    ...compose,
    services: {
      ...compose.services,
      [serviceName]: updatedService,
    },
  };
}

// ---------------------------------------------------------------------------
// Traefik label stripping
// ---------------------------------------------------------------------------

/**
 * Strip all Traefik labels from every service in the compose file.
 * Used before re-injecting fresh Traefik config to prevent stale router names
 * from accumulating (e.g. "appname" from import vs "appname-abc123" from deploy).
 * Returns a new ComposeFile — does not mutate the original.
 */
export function stripTraefikLabels(compose: ComposeFile): ComposeFile {
  const updatedServices: Record<string, ComposeService> = {};
  for (const [svcName, svc] of Object.entries(compose.services)) {
    if (!svc.labels) {
      updatedServices[svcName] = svc;
      continue;
    }
    const stripped = Object.fromEntries(
      Object.entries(svc.labels).filter(([k]) => !k.startsWith(TRAEFIK_LABEL_PREFIX))
    );
    updatedServices[svcName] = { ...svc, labels: stripped };
  }
  return { ...compose, services: updatedServices };
}

// ---------------------------------------------------------------------------
// Network injection
// ---------------------------------------------------------------------------

/**
 * Add an external network to the compose file and attach every service to it.
 * Returns a new ComposeFile -- does not mutate the original.
 */
export function injectNetwork(
  compose: ComposeFile,
  networkName: string = "vardo-network",
): ComposeFile {
  const updatedServices: Record<string, ComposeService> = {};
  for (const [key, svc] of Object.entries(compose.services)) {
    if (svc.network_mode) {
      updatedServices[key] = svc;
      continue;
    }
    const existingNetworks = svc.networks ?? [];
    updatedServices[key] = {
      ...svc,
      networks: existingNetworks.includes(networkName)
        ? existingNetworks
        : [...existingNetworks, networkName],
    };
  }

  const anyServiceUsesNetwork = Object.values(updatedServices).some(
    (svc) => svc.networks?.includes(networkName)
  );

  const existingNetworks = (compose.networks ?? {}) as Record<string, unknown>;

  return {
    ...compose,
    services: updatedServices,
    networks: anyServiceUsesNetwork
      ? { ...existingNetworks, [networkName]: { external: true } }
      : existingNetworks,
  };
}

// ---------------------------------------------------------------------------
// Resource limit injection
// ---------------------------------------------------------------------------

export function injectResourceLimits(
  compose: ComposeFile,
  opts: { cpuLimit?: number | null; memoryLimit?: number | null },
): ComposeFile {
  if (!opts.cpuLimit && !opts.memoryLimit) return compose;
  const limits: ResourceLimits = {};
  if (opts.cpuLimit) limits.cpus = String(opts.cpuLimit);
  if (opts.memoryLimit) limits.memory = `${opts.memoryLimit}M`;
  const updatedServices: Record<string, ComposeService> = {};
  for (const [key, svc] of Object.entries(compose.services)) {
    updatedServices[key] = { ...svc, deploy: { ...svc.deploy, resources: { ...svc.deploy?.resources, limits: { ...svc.deploy?.resources?.limits, ...limits } } } };
  }
  return { ...compose, services: updatedServices };
}

// ---------------------------------------------------------------------------
// GPU / device injection
// ---------------------------------------------------------------------------

/**
 * Inject NVIDIA GPU access into every service in a compose file via
 * deploy.resources.reservations.devices.  Uses `count: all` so every
 * available GPU is accessible.  Returns a new ComposeFile — does not
 * mutate the original.
 *
 * This is a whole-app toggle — all services in the compose file receive
 * the NVIDIA runtime reservation.  For multi-service apps, every container
 * gets the overhead regardless of whether it actually needs GPU access.
 */
export function injectGpuDevices(compose: ComposeFile): ComposeFile {
  const updatedServices: Record<string, ComposeService> = {};
  for (const [key, svc] of Object.entries(compose.services)) {
    const existingDevices = svc.deploy?.resources?.reservations?.devices ?? [];
    const alreadyHasGpu = existingDevices.some((d) =>
      d.capabilities?.includes("gpu")
    );
    if (alreadyHasGpu) {
      updatedServices[key] = svc;
      continue;
    }
    updatedServices[key] = {
      ...svc,
      deploy: {
        ...svc.deploy,
        resources: {
          ...svc.deploy?.resources,
          reservations: {
            ...svc.deploy?.resources?.reservations,
            devices: [
              ...existingDevices,
              { driver: "nvidia", count: "all", capabilities: ["gpu"] },
            ],
          },
        },
      },
    };
  }
  return { ...compose, services: updatedServices };
}

// ---------------------------------------------------------------------------
// Port detection
// ---------------------------------------------------------------------------

export type PortMapping = {
  serviceName: string;
  internal: number;
  external?: number;
};

/**
 * Parse port mappings from all services in a compose file.
 *
 * Handles formats:
 *   "3000"              -> internal 3000
 *   "8080:3000"         -> external 8080, internal 3000
 *   "0.0.0.0:8080:3000" -> external 8080, internal 3000
 *   "8080:3000/tcp"     -> external 8080, internal 3000 (protocol stripped)
 */
export function detectPorts(compose: ComposeFile): PortMapping[] {
  const results: PortMapping[] = [];

  for (const [name, svc] of Object.entries(compose.services)) {
    if (!svc.ports) continue;

    for (const raw of svc.ports) {
      const mapping = parsePortString(raw);
      if (mapping) {
        results.push({ serviceName: name, ...mapping });
      }
    }
  }

  return results;
}

function parsePortString(
  raw: string,
): { internal: number; external?: number } | null {
  // Strip protocol suffix (e.g. /tcp, /udp)
  const stripped = raw.split("/")[0];
  const parts = stripped.split(":");

  if (parts.length === 1) {
    // "3000"
    const port = parseInt(parts[0], 10);
    return isNaN(port) ? null : { internal: port };
  }

  if (parts.length === 2) {
    // "8080:3000"
    const external = parseInt(parts[0], 10);
    const internal = parseInt(parts[1], 10);
    return isNaN(internal) ? null : { internal, external: isNaN(external) ? undefined : external };
  }

  if (parts.length === 3) {
    // "0.0.0.0:8080:3000"
    const external = parseInt(parts[1], 10);
    const internal = parseInt(parts[2], 10);
    return isNaN(internal) ? null : { internal, external: isNaN(external) ? undefined : external };
  }

  return null;
}

// ---------------------------------------------------------------------------
// YAML serialization (minimal, sufficient for Docker Compose)
// ---------------------------------------------------------------------------

import { resolve } from "path";
import YAML from "yaml";

/**
 * Serialize a ComposeFile to a YAML string.
 */
export function composeToYaml(compose: ComposeFile): string {
  const doc: Record<string, unknown> = {};

  const services: Record<string, Record<string, unknown>> = {};
  for (const [key, svc] of Object.entries(compose.services)) {
    const { name: _name, ...rest } = svc;
    services[key] = rest;
  }
  doc.services = services;

  if (compose.networks && Object.keys(compose.networks).length > 0) {
    doc.networks = compose.networks;
  }
  if (compose.volumes && Object.keys(compose.volumes).length > 0) {
    doc.volumes = compose.volumes;
  }

  return YAML.stringify(doc);
}

/**
 * Parse a YAML string into a ComposeFile.
 */
export function parseCompose(yamlString: string): ComposeFile {
  const parsed = YAML.parse(yamlString);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid compose file: root must be a YAML mapping");
  }

  const root = parsed as Record<string, unknown>;
  if (!root.services || typeof root.services !== "object") {
    throw new Error('Invalid compose file: missing or invalid "services" key');
  }

  const services: Record<string, ComposeService> = {};
  const rawServices = root.services as Record<string, Record<string, unknown>>;

  for (const [name, raw] of Object.entries(rawServices)) {
    const svc: ComposeService = { name };

    if (raw.image && typeof raw.image === "string") svc.image = raw.image;
    if (raw.build !== undefined) svc.build = raw.build as ComposeService["build"];
    if (typeof raw.restart === "string") svc.restart = raw.restart;
    if (Array.isArray(raw.ports)) svc.ports = raw.ports.map(String);
    if (raw.environment && typeof raw.environment === "object") {
      if (Array.isArray(raw.environment)) {
        const envMap: Record<string, string> = {};
        for (const item of raw.environment) {
          const s = String(item);
          const eq = s.indexOf("=");
          if (eq > 0) envMap[s.slice(0, eq)] = s.slice(eq + 1);
        }
        svc.environment = envMap;
      } else {
        svc.environment = raw.environment as Record<string, string>;
      }
    }
    if (raw.env_file) {
      if (Array.isArray(raw.env_file)) svc.env_file = raw.env_file.map(String);
      else if (typeof raw.env_file === "string") svc.env_file = [raw.env_file];
    }
    if (Array.isArray(raw.volumes)) svc.volumes = raw.volumes.map(String);
    if (raw.labels) {
      if (Array.isArray(raw.labels)) {
        const labelMap: Record<string, string> = {};
        for (const item of raw.labels) {
          const s = String(item);
          const eq = s.indexOf("=");
          if (eq > 0) labelMap[s.slice(0, eq)] = s.slice(eq + 1);
          else labelMap[s] = "";
        }
        svc.labels = labelMap;
      } else if (typeof raw.labels === "object") {
        svc.labels = raw.labels as Record<string, string>;
      }
    }
    if (Array.isArray(raw.networks)) svc.networks = raw.networks.map(String);
    // depends_on: array of strings or object with service keys
    if (raw.depends_on) {
      if (Array.isArray(raw.depends_on)) {
        svc.depends_on = raw.depends_on.map(String);
      } else if (typeof raw.depends_on === "object") {
        svc.depends_on = Object.keys(raw.depends_on);
      }
    }
    if (raw.network_mode && typeof raw.network_mode === "string") {
      const nm = raw.network_mode;
      if (ALLOWED_NETWORK_MODES.some((p) => nm === p || nm.startsWith(p + ":"))) {
        svc.network_mode = nm;
      }
    }
    if (raw.runtime && typeof raw.runtime === "string" && ALLOWED_RUNTIMES.includes(raw.runtime)) {
      svc.runtime = raw.runtime;
    }
    if (
      raw.deploy &&
      typeof raw.deploy === "object" &&
      !Array.isArray(raw.deploy) &&
      (
        !("resources" in raw.deploy) ||
        (typeof raw.deploy.resources === "object" && raw.deploy.resources !== null)
      )
    ) {
      svc.deploy = raw.deploy as ComposeService["deploy"];
    }
    if (Array.isArray(raw.cap_add)) svc.cap_add = raw.cap_add.map(String);
    if (Array.isArray(raw.cap_drop)) svc.cap_drop = raw.cap_drop.map(String);
    if (Array.isArray(raw.devices)) svc.devices = raw.devices.map(String);
    if (typeof raw.privileged === "boolean" && raw.privileged) svc.privileged = raw.privileged;
    if (Array.isArray(raw.security_opt)) svc.security_opt = raw.security_opt.map(String);
    if (typeof raw.shm_size === "string" && raw.shm_size) svc.shm_size = raw.shm_size;
    if (typeof raw.init === "boolean" && raw.init) svc.init = raw.init;
    if (Array.isArray(raw.extra_hosts)) svc.extra_hosts = raw.extra_hosts.map(String);
    if (raw.healthcheck && typeof raw.healthcheck === "object" && !Array.isArray(raw.healthcheck)) {
      svc.healthcheck = raw.healthcheck as HealthCheck;
    }
    if (raw.ulimits && typeof raw.ulimits === "object" && !Array.isArray(raw.ulimits)) {
      svc.ulimits = raw.ulimits as Ulimits;
    }
    if (typeof raw.hostname === "string" && raw.hostname) svc.hostname = raw.hostname;
    if (typeof raw.user === "string" && raw.user) svc.user = raw.user;
    if (typeof raw.stop_signal === "string" && raw.stop_signal) svc.stop_signal = raw.stop_signal;
    if (raw.entrypoint !== undefined) {
      if (Array.isArray(raw.entrypoint)) svc.entrypoint = raw.entrypoint.map(String);
      else if (typeof raw.entrypoint === "string") svc.entrypoint = raw.entrypoint;
    }
    if (raw.command !== undefined) {
      if (Array.isArray(raw.command)) svc.command = raw.command.map(String);
      else if (typeof raw.command === "string") svc.command = raw.command;
    }
    if (Array.isArray(raw.tmpfs)) svc.tmpfs = raw.tmpfs.map(String);
    else if (typeof raw.tmpfs === "string") svc.tmpfs = [raw.tmpfs];

    services[name] = svc;
  }

  const result: ComposeFile = { services };
  if (root.networks && typeof root.networks === "object") {
    result.networks = root.networks as Record<string, unknown>;
  }
  if (root.volumes && typeof root.volumes === "object") {
    result.volumes = root.volumes as Record<string, unknown>;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SERVICE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PORT_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:)?(\d+:)?\d+(\/\w+)?$/;

const ALLOWED_NETWORK_MODES = ["host", "bridge", "none", "service", "container"];
const ALLOWED_RUNTIMES = ["runc", "nvidia", "sysbox"];

const DENIED_MOUNT_PATHS = [
  "/etc",
  "/proc",
  "/sys",
  "/var/run/docker.sock",
  "/root",
];

/**
 * Returns true if a Docker inspect mount name represents an anonymous volume.
 * Docker assigns a 64-character hex hash as the name for anonymous volumes.
 * An empty name is also treated as anonymous.
 */
export function isAnonymousVolume(name: string): boolean {
  return !name || /^[0-9a-f]{64}$/.test(name);
}

type ValidateOptions = {
  allowBindMounts?: boolean;
  /** Skip all mount-related validation checks. Used when the org is trusted. */
  skipMountChecks?: boolean;
};

/**
 * Returns true if a compose volume entry is a host bind mount.
 * A bare absolute path like "/data" (no colon) is a Docker anonymous volume —
 * it must not be treated as a bind mount.
 */
function isBindMount(vol: string): boolean {
  return (
    vol.startsWith("./") ||
    vol.startsWith("../") ||
    (vol.startsWith("/") && vol.includes(":"))
  );
}

/**
 * Basic validation of a ComposeFile structure.
 */
export function validateCompose(compose: ComposeFile, opts?: ValidateOptions): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (
    !compose.services ||
    typeof compose.services !== "object" ||
    Object.keys(compose.services).length === 0
  ) {
    errors.push("Compose file must have at least one service");
    return { valid: false, errors };
  }

  for (const [name, svc] of Object.entries(compose.services)) {
    // Validate service name
    if (!SERVICE_NAME_RE.test(name)) {
      errors.push(
        `Service name "${name}" is invalid (must be lowercase alphanumeric with hyphens, starting with a letter)`,
      );
    }

    // Each service must have image or build
    if (!svc.image && !svc.build) {
      errors.push(`Service "${name}" must have either "image" or "build"`);
    }

    // Validate port formats
    if (svc.ports) {
      for (const port of svc.ports) {
        if (!PORT_RE.test(port)) {
          errors.push(
            `Service "${name}" has invalid port format: "${port}"`,
          );
        }
      }
    }

    if (svc.volumes && !opts?.skipMountChecks) {
      for (const vol of svc.volumes) {
        if (isBindMount(vol) && !opts?.allowBindMounts) {
          errors.push(
            `Service "${name}" uses host bind mount "${vol}" — enable the Bind Mounts feature flag to allow this`,
          );
        }
        if (isBindMount(vol) && opts?.allowBindMounts) {
          const mountSource = resolve(vol.split(":")[0]);
          if (DENIED_MOUNT_PATHS.some((p) => mountSource === p || mountSource.startsWith(p + "/"))) {
            errors.push(
              `Service "${name}" mounts denied path "${mountSource}" — this path is blocked for security`,
            );
          }
        }
      }
    }

    // Validate network_mode service:X references
    if (svc.network_mode) {
      const nm = svc.network_mode;
      if (nm.startsWith("service:")) {
        const targetService = nm.slice("service:".length);
        if (!targetService) {
          errors.push(`Service "${name}" has invalid network_mode "${nm}" — service name is empty`);
        } else if (!compose.services[targetService]) {
          errors.push(
            `Service "${name}" has network_mode "${nm}" but service "${targetService}" is not defined`,
          );
        } else if (targetService === name) {
          errors.push(`Service "${name}" cannot reference itself in network_mode`);
        }
      }
    }
  }

  // Detect circular chains in service:X network_mode references (A → B → A or longer).
  // Self-references (A → A) are already caught above; this covers multi-hop cycles.
  const cycleMembers = new Set<string>();
  const cycleReported = new Set<string>();
  for (const startName of Object.keys(compose.services)) {
    if (cycleMembers.has(startName)) continue;

    const path: string[] = [];
    const seen = new Set<string>();
    let node = startName;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const nm = compose.services[node]?.network_mode;
      if (!nm?.startsWith("service:")) break;
      const next = nm.slice("service:".length);
      // Skip invalid/missing/self-ref targets — already reported above
      if (!next || !compose.services[next] || next === node) break;

      if (seen.has(next)) {
        // next appears earlier in the path — cycle detected
        const cycleStart = path.indexOf(next);
        const cycle = [...path.slice(cycleStart), node];
        const cycleKey = [...cycle].sort().join(",");
        if (!cycleReported.has(cycleKey)) {
          cycleReported.add(cycleKey);
          for (const n of cycle) cycleMembers.add(n);
          errors.push(
            `Circular network_mode chain detected: ${[...cycle, next].join(" → ")}`,
          );
        }
        break;
      }

      path.push(node);
      seen.add(node);
      node = next;
    }
  }

  // Detect non-circular chaining: service:B where B itself uses service:X.
  // Docker does not allow network_mode chains — the target must own its network namespace.
  for (const [name, svc] of Object.entries(compose.services)) {
    if (!svc.network_mode?.startsWith("service:")) continue;
    if (cycleMembers.has(name)) continue; // already covered by circular error above

    const targetService = svc.network_mode.slice("service:".length);
    if (!targetService || !compose.services[targetService] || targetService === name) continue;

    if (compose.services[targetService].network_mode?.startsWith("service:")) {
      errors.push(
        `Service "${name}" uses network_mode "service:${targetService}", but "${targetService}" also uses a service: network_mode — Docker does not support chaining`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Strip host bind mounts from compose, keeping only named volumes.
 * When allowBindMounts is true, bind mounts are allowed but paths in
 * DENIED_MOUNT_PATHS are always blocked regardless of the flag.
 * When stripping, returns the list of removed mounts for logging.
 */
type DeployTransformDomain = {
  id: string;
  domain: string;
  port: number | null;
  sslEnabled: boolean | null;
  certResolver: string | null;
  redirectTo: string | null;
  redirectCode: number | null;
};

/**
 * Apply the standard deployment transformation chain to a compose file.
 *
 * Injects resource limits, GPU devices, Traefik labels, and the shared
 * vardo network — the same sequence used during deploy. Both the deploy
 * path and the debug endpoint use this so the preview matches what
 * actually runs.
 */
export function applyDeployTransforms(
  compose: ComposeFile,
  opts: {
    appName: string;
    containerPort: number | null;
    cpuLimit?: number | null;
    memoryLimit?: number | null;
    gpuEnabled?: boolean;
    domains: DeployTransformDomain[];
    networkName: string;
    backendProtocol?: "http" | "https" | null;
  },
): ComposeFile {
  let result = compose;

  if (opts.cpuLimit || opts.memoryLimit) {
    result = injectResourceLimits(result, {
      cpuLimit: opts.cpuLimit,
      memoryLimit: opts.memoryLimit,
    });
  }

  if (opts.gpuEnabled) {
    result = injectGpuDevices(result);
  }

  const servicesWithCustomNetwork = Object.entries(result.services)
    .filter(([, svc]) => svc.network_mode && svc.network_mode !== "bridge")
    .map(([name]) => name);
  const allServicesCustomNetwork =
    servicesWithCustomNetwork.length === Object.keys(result.services).length;

  if (!allServicesCustomNetwork) {
    result = stripTraefikLabels(result);

    const primaryServiceName = Object.keys(result.services).find(
      (k) => !result.services[k].network_mode || result.services[k].network_mode === "bridge",
    );

    for (const domain of opts.domains) {
      const port = domain.port || opts.containerPort || 3000;
      const resolvedProtocol = resolveBackendProtocol(opts.backendProtocol, port);
      result = injectTraefikLabels(result, {
        projectName: `${opts.appName}-${domain.id.slice(0, 6)}`,
        appName: opts.appName,
        domain: domain.domain,
        containerPort: port,
        certResolver: domain.certResolver || "le",
        ssl: domain.sslEnabled ?? true,
        redirectTo: domain.redirectTo ?? undefined,
        redirectCode: domain.redirectCode ?? 301,
        serviceName: primaryServiceName,
        backendProtocol: resolvedProtocol,
      });
    }
  }

  result = injectNetwork(result, opts.networkName);

  return result;
}

export function sanitizeCompose(compose: ComposeFile, opts?: { allowBindMounts?: boolean }): {
  compose: ComposeFile;
  strippedMounts: string[];
} {
  const strippedMounts: string[] = [];
  const sanitized = { ...compose, services: { ...compose.services } };
  for (const [name, svc] of Object.entries(sanitized.services)) {
    if (svc.volumes) {
      const safe: string[] = [];
      for (const v of svc.volumes) {
        if (isBindMount(v)) {
          if (opts?.allowBindMounts) {
            // Bind mounts allowed — still enforce the deny list unconditionally.
            // Throw rather than silently drop: the user explicitly configured this
            // mount, so a silent strip would cause confusing runtime behaviour.
            const mountSource = resolve(v.split(":")[0]);
            if (DENIED_MOUNT_PATHS.some((p) => mountSource === p || mountSource.startsWith(p + "/"))) {
              throw new Error(
                `Service "${name}" mounts blocked host path "${mountSource}" — this path is not allowed even with bind mounts enabled`,
              );
            }
            safe.push(v);
          } else {
            strippedMounts.push(`${name}: ${v}`);
          }
        } else {
          safe.push(v);
        }
      }
      sanitized.services[name] = { ...svc, volumes: safe };
    }
  }
  return { compose: sanitized, strippedMounts };
}

type ComposePreviewApp = {
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

/**
 * Build a compose preview from the app's stored configuration.
 *
 * Applies the same transformation chain as deploy without cloning a repo or
 * building images. Used by the debug endpoint to show what the compose file
 * would look like at runtime.
 *
 * Returns null for git-sourced apps that have no stored compose content —
 * their compose is generated during the build step and is not available
 * statically.
 */
export function buildComposePreview(
  app: ComposePreviewApp,
  volumesList: { name: string; mountPath: string }[],
  networkName: string,
  orgTrusted?: boolean,
): ComposeFile | null {
  let compose: ComposeFile | null = null;

  if (app.deployType === "image" && app.composeContent) {
    // Imported container — use stored compose
    try {
      const parsed = parseCompose(app.composeContent);
      if (orgTrusted) {
        compose = parsed;
      } else {
        const { compose: sanitized } = sanitizeCompose(parsed, { allowBindMounts: true });
        compose = sanitized;
      }
    } catch {
      return null;
    }
  } else if (app.deployType === "image" && app.imageName) {
    compose = generateComposeForImage({
      projectName: app.name,
      imageName: app.imageName,
      containerPort: app.containerPort ?? undefined,
      volumes: volumesList.length > 0 ? volumesList : undefined,
      exposedPorts: app.exposedPorts ?? undefined,
    });
  } else if (app.composeContent) {
    // Stored compose content (git repos with inline compose)
    try {
      const parsed = parseCompose(app.composeContent);
      if (orgTrusted) {
        compose = parsed;
      } else {
        const { compose: sanitized } = sanitizeCompose(parsed, { allowBindMounts: true });
        compose = sanitized;
      }
    } catch {
      return null;
    }
  } else {
    // Git repo — compose is generated during build, not available statically
    return null;
  }

  if (!compose) return null;

  return applyDeployTransforms(compose, {
    appName: app.name,
    containerPort: app.containerPort,
    cpuLimit: app.cpuLimit,
    memoryLimit: app.memoryLimit,
    gpuEnabled: app.gpuEnabled,
    domains: app.domains,
    networkName,
    backendProtocol: app.backendProtocol,
  });
}
