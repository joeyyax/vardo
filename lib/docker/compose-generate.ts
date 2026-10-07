import type {
  ComposeFile,
  ComposeService,
  ContainerConfig,
  HealthCheck,
  ResourceLimits,
  Ulimits,
} from "./compose-types";
import { isAnonymousVolume } from "./compose-validate";

// Only labels with these prefixes survive the import filter.
export const TRAEFIK_LABEL_PREFIX = "traefik.";
const ALLOWED_LABEL_PREFIXES = [TRAEFIK_LABEL_PREFIX, "vardo."];

/** Byte count to a compact size string, exact multiples only so round-trips don't drift. */
function bytesToSizeString(bytes: number): string {
  const GiB = 1024 * 1024 * 1024;
  const MiB = 1024 * 1024;
  const KiB = 1024;
  if (bytes % GiB === 0) return `${bytes / GiB}g`;
  if (bytes % MiB === 0) return `${bytes / MiB}m`;
  if (bytes % KiB === 0) return `${bytes / KiB}k`;
  return `${bytes}b`;
}

/** Docker's nanosecond duration to a compose duration string. */
export function nanosToDuration(nanos: number): string {
  const ms = nanos / 1e6;
  const s = ms / 1000;
  const m = s / 60;
  if (Number.isInteger(m) && m >= 1) return `${m}m`;
  if (Number.isInteger(s) && s >= 1) return `${s}s`;
  if (Number.isInteger(ms) && ms >= 1) return `${ms}ms`;
  return `${Math.round(s)}s`;
}

/** ComposeFile for a single-image project, with the service named after the project. */
export function generateComposeForImage(opts: {
  projectName: string;
  imageName: string;
  containerPort?: number;
  envVars?: Record<string, string>;
  volumes?: { name: string; mountPath: string }[];
  exposedPorts?: { internal: number; external?: number; protocol?: string }[];
}): ComposeFile {
  const { projectName, imageName, envVars, volumes, exposedPorts } = opts;

  const service: ComposeService = {
    name: projectName,
    image: imageName,
    restart: "unless-stopped",
  };

  if (exposedPorts && exposedPorts.length > 0) {
    service.ports = exposedPorts
      .filter((p) => p.external)
      .map((p) => `${p.external}:${p.internal}${p.protocol ? `/${p.protocol}` : ""}`);
  }

  // Load env via env_file. Inlined, Compose would interpolate ${} template expressions.
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

  if (volumes && volumes.length > 0) {
    compose.volumes = {};
    for (const v of volumes) {
      compose.volumes[v.name] = {};
    }
  }

  return compose;
}

/** Narrow a DB string to the backend protocol union, null for anything else. */
export function narrowBackendProtocol(
  value: string | null | undefined,
): "http" | "https" | null {
  if (value === "http" || value === "https") return value;
  return null;
}

/** Backend protocol Traefik uses. Explicit value wins; otherwise ports 443 and 8443 mean https. */
export function resolveBackendProtocol(
  backendProtocol: "http" | "https" | null | undefined,
  port: number,
): "http" | "https" {
  if (backendProtocol === "https") return "https";
  if (backendProtocol === "http") return "http";
  return port === 443 || port === 8443 ? "https" : "http";
}

/** ComposeFile reproducing a captured container spec. Bind mounts are included as given. */
export function generateComposeFromContainer(
  serviceName: string,
  container: ContainerConfig,
): ComposeFile {
  const service: ComposeService = {
    name: serviceName,
    image: container.image,
  };

  const restart =
    container.restartPolicy && container.restartPolicy !== "no"
      ? container.restartPolicy
      : "unless-stopped";
  service.restart = restart;

  const externalPorts = container.ports.filter((p) => p.external);
  if (externalPorts.length > 0) {
    service.ports = externalPorts.map((p) => {
      const proto = p.protocol && p.protocol !== "tcp" ? `/${p.protocol}` : "";
      return `${p.external}:${p.internal}${proto}`;
    });
  }

  // The .env file is written during deploy.
  if (container.hasEnvVars) {
    service.env_file = [".env"];
  }

  // Anonymous volumes are emitted as a bare container path.
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

  // Special modes stay network_mode. A named network there would make injectNetwork skip
  // the service, so it never joins vardo-network.
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
      service.networks = [container.networkMode];
    }
  }

  const filteredLabels = Object.fromEntries(
    Object.entries(container.labels).filter(
      ([k]) => ALLOWED_LABEL_PREFIXES.some((prefix) => k.startsWith(prefix))
    )
  );
  if (Object.keys(filteredLabels).length > 0) service.labels = filteredLabels;

  if (container.capAdd.length > 0) service.cap_add = container.capAdd;
  if (container.capDrop.length > 0) service.cap_drop = container.capDrop;

  if (container.devices.length > 0) {
    service.devices = container.devices.map((d) => {
      const perms =
        d.permissions && d.permissions !== "rwm" ? `:${d.permissions}` : "";
      return `${d.hostPath}:${d.containerPath}${perms}`;
    });
  }

  if (container.privileged) service.privileged = true;

  if (container.securityOpt.length > 0) service.security_opt = container.securityOpt;

  const DEFAULT_SHM_SIZE = 64 * 1024 * 1024;
  if (container.shmSize > 0 && container.shmSize !== DEFAULT_SHM_SIZE) {
    service.shm_size = bytesToSizeString(container.shmSize);
  }

  if (container.init) service.init = true;

  if (container.extraHosts.length > 0) service.extra_hosts = container.extraHosts;

  if (container.nanoCpus > 0 || container.memoryBytes > 0) {
    const limits: ResourceLimits = {};
    if (container.nanoCpus > 0) limits.cpus = String(container.nanoCpus / 1e9);
    if (container.memoryBytes > 0) limits.memory = bytesToSizeString(container.memoryBytes);
    service.deploy = { resources: { limits } };
  }

  if (container.ulimits.length > 0) {
    const ulimits: Ulimits = {};
    for (const u of container.ulimits) {
      ulimits[u.name] =
        u.soft === u.hard ? u.soft : { soft: u.soft, hard: u.hard };
    }
    service.ulimits = ulimits;
  }

  if (container.tmpfs.length > 0) service.tmpfs = container.tmpfs;

  // Skip a Docker-assigned short container ID; it would conflict on redeploy.
  if (container.hostname && !/^[a-f0-9]{12}$/.test(container.hostname)) {
    service.hostname = container.hostname;
  }

  if (container.user) service.user = container.user;

  if (container.stopSignal && container.stopSignal !== "SIGTERM") {
    service.stop_signal = container.stopSignal;
  }

  if (container.healthcheck) {
    const hc = container.healthcheck;
    const spec: HealthCheck = { test: hc.test };
    if (hc.interval > 0) spec.interval = nanosToDuration(hc.interval);
    if (hc.timeout > 0) spec.timeout = nanosToDuration(hc.timeout);
    if (hc.retries > 0) spec.retries = hc.retries;
    if (hc.startPeriod > 0) spec.start_period = nanosToDuration(hc.startPeriod);
    service.healthcheck = spec;
  }

  if (container.entrypoint.length > 0) service.entrypoint = container.entrypoint;

  if (container.command.length > 0) service.command = container.command;

  const compose: ComposeFile = {
    services: { [serviceName]: service },
  };

  if (namedVolumes.length > 0) {
    compose.volumes = {};
    for (const v of namedVolumes) {
      compose.volumes[v.name] = {};
    }
  }

  // Named networks pre-exist, so declare them external.
  if (service.networks && service.networks.length > 0) {
    compose.networks = {};
    for (const net of service.networks) {
      compose.networks[net] = { external: true };
    }
  }

  return compose;
}
