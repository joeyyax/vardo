// ---------------------------------------------------------------------------
// Docker Compose generation and manipulation for Host projects.
//
// NOTE: This module includes a minimal YAML serializer/parser sufficient for
// Docker Compose files. For production hardening, install `yaml` or `js-yaml`
// and swap the implementations of `composeToYaml` and `parseCompose`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResourceLimits = {
  cpus?: string;
  memory?: string;
};

export type ComposeService = {
  name: string;
  image?: string;
  build?: string | { context: string; dockerfile?: string };
  ports?: string[];
  environment?: Record<string, string>;
  env_file?: string[];
  volumes?: string[];
  labels?: Record<string, string>;
  networks?: string[];
  depends_on?: string[];
  deploy?: {
    resources?: {
      limits?: ResourceLimits;
    };
  };
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
    certResolver?: string;
    ssl?: boolean;
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

  const labels: Record<string, string> = {
    ...existing.labels,
    "traefik.enable": "true",
    [`traefik.http.routers.${projectName}.rule`]: `Host(\`${domain}\`)`,
    [`traefik.http.services.${projectName}.loadbalancer.server.port`]:
      String(containerPort),
  };

  if (ssl) {
    // HTTPS — websecure entrypoint with TLS
    labels[`traefik.http.routers.${projectName}.entrypoints`] = "websecure";
    labels[`traefik.http.routers.${projectName}.tls`] = "true";

    // Production: use cert resolver (Let's Encrypt / Google)
    // Local: Traefik auto-generates self-signed certs
    if (!isLocal) {
      labels[`traefik.http.routers.${projectName}.tls.certresolver`] = certResolver;
    }

    // HTTP redirect router — catches port-80 traffic and sends it to HTTPS.
    // The global Traefik redirect handles the Vardo app itself; user projects
    // need their own per-router redirect so the correct Host rule matches.
    labels[`traefik.http.routers.${projectName}-http.rule`] = `Host(\`${domain}\`)`;
    labels[`traefik.http.routers.${projectName}-http.entrypoints`] = "web";
    labels[`traefik.http.middlewares.${projectName}-https-redirect.redirectscheme.scheme`] = "https";
    labels[`traefik.http.middlewares.${projectName}-https-redirect.redirectscheme.permanent`] = "true";
    labels[`traefik.http.routers.${projectName}-http.middlewares`] = `${projectName}-https-redirect`;
  } else {
    // HTTP only — web entrypoint, no TLS
    labels[`traefik.http.routers.${projectName}.entrypoints`] = "web";
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
// Network injection
// ---------------------------------------------------------------------------

/**
 * Add an external network to the compose file and attach every service to it.
 * Returns a new ComposeFile -- does not mutate the original.
 */
export function injectNetwork(
  compose: ComposeFile,
  networkName: string = "host-network",
): ComposeFile {
  const updatedServices: Record<string, ComposeService> = {};
  for (const [key, svc] of Object.entries(compose.services)) {
    const existingNetworks = svc.networks ?? [];
    updatedServices[key] = {
      ...svc,
      networks: existingNetworks.includes(networkName)
        ? existingNetworks
        : [...existingNetworks, networkName],
    };
  }

  const existingNetworks = (compose.networks ?? {}) as Record<string, unknown>;

  return {
    ...compose,
    services: updatedServices,
    networks: {
      ...existingNetworks,
      [networkName]: { external: true },
    },
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

/**
 * Basic validation of a ComposeFile structure.
 */
export function validateCompose(compose: ComposeFile): {
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

    // Check for host bind mounts (paths starting with / or ./)
    if (svc.volumes) {
      for (const vol of svc.volumes) {
        if (vol.startsWith("/") || vol.startsWith("./") || vol.startsWith("../")) {
          errors.push(
            `Service "${name}" uses host bind mount "${vol}" — only named volumes are allowed`,
          );
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Strip host bind mounts from compose, keeping only named volumes.
 * Used when allowUnsafeCompose is false.
 */
export function sanitizeCompose(compose: ComposeFile): ComposeFile {
  const sanitized = { ...compose, services: { ...compose.services } };
  for (const [name, svc] of Object.entries(sanitized.services)) {
    if (svc.volumes) {
      const safe = svc.volumes.filter(
        (v) => !v.startsWith("/") && !v.startsWith("./") && !v.startsWith("../")
      );
      sanitized.services[name] = { ...svc, volumes: safe };
    }
  }
  return sanitized;
}
