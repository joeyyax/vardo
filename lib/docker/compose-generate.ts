// ---------------------------------------------------------------------------
// Compose generation from images and containers.
// ---------------------------------------------------------------------------

import type {
  ComposeFile,
  ComposeService,
  ContainerConfig,
  HealthCheck,
  ResourceLimits,
  Ulimits,
} from "./compose-types";
import { isAnonymousVolume } from "./compose-validate";

// Only labels with these prefixes survive the import filter. Everything else
// (OCI image metadata, Docker Compose internals, arbitrary user labels) is
// stripped so the generated compose stays clean. Traefik routing labels are
// allowed through because they may carry custom middleware config; Vardo labels
// are allowed so any user-set vardo.* metadata is preserved. Both will be
// re-evaluated and overwritten during deploy anyway.
export const TRAEFIK_LABEL_PREFIX = "traefik.";
const ALLOWED_LABEL_PREFIXES = [TRAEFIK_LABEL_PREFIX, "vardo."];

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
// Import-from-container compose generation
// ---------------------------------------------------------------------------

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
