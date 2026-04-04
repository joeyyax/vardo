// ---------------------------------------------------------------------------
// Traefik label injection/stripping, network injection, resource limits,
// GPU device injection, port parsing/stripping, overlay generation, slot
// compose helpers, and deploy transforms.
// ---------------------------------------------------------------------------

import { access } from "fs/promises";
import { join } from "path";
import type {
  ComposeFile,
  ComposeService,
  ComposePreviewApp,
  DeployTransformDomain,
  PortMapping,
  ResourceLimits,
} from "./compose-types";
import { TRAEFIK_LABEL_PREFIX, resolveBackendProtocol } from "./compose-generate";
import { parseCompose } from "./compose-parse";
import { sanitizeCompose } from "./compose-validate";
import { generateComposeForImage } from "./compose-generate";

const VARDO_LABEL_PREFIX = "vardo.";

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

  // Host port bindings are stripped separately by stripHostPorts() in the
  // deploy flow for the primary service. Secondary services keep their ports.
  const updatedService: ComposeService = {
    ...existing,
    labels,
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
// Slot compose file helpers
// ---------------------------------------------------------------------------

/**
 * Return the compose -f arguments for a slot directory.
 *
 * Docker Compose auto-loads docker-compose.override.yml when present, so we
 * only need to pass `-f docker-compose.yml`. For backwards compat, we also
 * check for the legacy `docker-compose.vardo.yml` and pass it explicitly.
 */
export async function slotComposeFiles(slotDir: string): Promise<string[]> {
  const base = join(slotDir, "docker-compose.yml");
  // Legacy overlay — explicit -f required
  const legacyOverlay = join(slotDir, "docker-compose.vardo.yml");
  try {
    await access(legacyOverlay);
    return ["-f", base, "-f", legacyOverlay];
  } catch {
    // docker-compose.override.yml is NOT auto-loaded when -f is passed,
    // so we must include it explicitly.
    const override = join(slotDir, "docker-compose.override.yml");
    try {
      await access(override);
      return ["-f", base, "-f", override];
    } catch {
      return ["-f", base];
    }
  }
}

// ---------------------------------------------------------------------------
// Vardo overlay generation
// ---------------------------------------------------------------------------

/**
 * Strip all Vardo-injected fields from a compose file, producing the bare user
 * compose. Removes Traefik labels, vardo.* labels, and the Vardo network from
 * services. Used to write the user-facing docker-compose.yml that can be run
 * standalone without Vardo.
 * Returns a new ComposeFile — does not mutate the original.
 */
export function stripVardoInjections(
  compose: ComposeFile,
  networkName: string = "vardo-network",
): ComposeFile {
  const updatedServices: Record<string, ComposeService> = {};
  for (const [name, svc] of Object.entries(compose.services)) {
    const strippedLabels = svc.labels
      ? Object.fromEntries(
          Object.entries(svc.labels).filter(
            ([k]) => !k.startsWith(TRAEFIK_LABEL_PREFIX) && !k.startsWith(VARDO_LABEL_PREFIX),
          ),
        )
      : undefined;
    const strippedNetworks = svc.networks?.filter((n) => n !== networkName);
    updatedServices[name] = {
      ...svc,
      ...(strippedLabels && Object.keys(strippedLabels).length > 0
        ? { labels: strippedLabels }
        : { labels: undefined }),
      ...(strippedNetworks && strippedNetworks.length > 0
        ? { networks: strippedNetworks }
        : { networks: undefined }),
    };
  }

  const strippedTopLevelNetworks =
    compose.networks &&
    Object.fromEntries(
      Object.entries(compose.networks as Record<string, unknown>).filter(
        ([k]) => k !== networkName,
      ),
    );

  return {
    ...compose,
    services: updatedServices,
    ...(strippedTopLevelNetworks && Object.keys(strippedTopLevelNetworks).length > 0
      ? { networks: strippedTopLevelNetworks }
      : { networks: undefined }),
  };
}

/**
 * Remove named services from a compose file. Also strips references to excluded
 * services from depends_on in remaining services.
 * Returns a new ComposeFile — does not mutate the original.
 */
export function excludeServices(
  compose: ComposeFile,
  serviceNames: string[]
): ComposeFile {
  const excluded = new Set(serviceNames);
  const filteredServices: Record<string, ComposeService> = {};

  for (const [name, svc] of Object.entries(compose.services)) {
    if (excluded.has(name)) continue;

    // Clean depends_on references to excluded services
    let cleanedDependsOn = svc.depends_on;
    if (cleanedDependsOn) {
      if (Array.isArray(cleanedDependsOn)) {
        const filtered = cleanedDependsOn.filter((d) => !excluded.has(d));
        cleanedDependsOn = filtered.length > 0 ? filtered : undefined;
      } else {
        const filtered = Object.fromEntries(
          Object.entries(cleanedDependsOn).filter(([k]) => !excluded.has(k))
        );
        cleanedDependsOn =
          Object.keys(filtered).length > 0 ? filtered : undefined;
      }
    }

    const { depends_on: _, ...rest } = svc;
    filteredServices[name] = cleanedDependsOn
      ? { ...rest, depends_on: cleanedDependsOn }
      : rest;
  }

  return {
    ...compose,
    services: filteredServices,
  };
}

/**
 * Build the Vardo overlay compose file containing only Vardo-injected config:
 * Traefik labels, vardo.* labels, vardo-network, resource limits from app
 * settings, GPU devices, and externalized volume declarations.
 *
 * Written as docker-compose.override.yml so Docker Compose auto-loads it:
 *   docker compose up -d
 */
export function buildVardoOverlay(opts: {
  fullCompose: ComposeFile;
  networkName: string;
  cpuLimit?: number | null;
  memoryLimit?: number | null;
  gpuEnabled?: boolean;
  externalVolumes?: Record<string, unknown>;
  bareVolumeNames?: string[];
}): ComposeFile {
  const {
    fullCompose,
    networkName,
    cpuLimit,
    memoryLimit,
    gpuEnabled,
    externalVolumes = {},
    bareVolumeNames = [],
  } = opts;

  const overlayServices: Record<string, ComposeService> = {};
  for (const [name, svc] of Object.entries(fullCompose.services)) {
    const vardoLabels = svc.labels
      ? Object.fromEntries(
          Object.entries(svc.labels).filter(
            ([k]) => k.startsWith(TRAEFIK_LABEL_PREFIX) || k.startsWith(VARDO_LABEL_PREFIX),
          ),
        )
      : undefined;

    const vardoNetworks = svc.networks?.includes(networkName) ? [networkName] : undefined;

    const overlayService: ComposeService = { name };

    if (vardoLabels && Object.keys(vardoLabels).length > 0) {
      overlayService.labels = vardoLabels;
    }
    if (vardoNetworks) {
      overlayService.networks = vardoNetworks;
    }

    // App-level resource limits set via Vardo UI (not from the user's compose)
    if (cpuLimit || memoryLimit) {
      const limits: ResourceLimits = {};
      if (cpuLimit) limits.cpus = String(cpuLimit);
      if (memoryLimit) limits.memory = `${memoryLimit}M`;
      overlayService.deploy = {
        ...(overlayService.deploy ?? {}),
        resources: {
          ...(overlayService.deploy?.resources ?? {}),
          limits: { ...(overlayService.deploy?.resources?.limits ?? {}), ...limits },
        },
      };
    }

    // GPU devices (Vardo UI setting)
    if (gpuEnabled) {
      const existingDevices = svc.deploy?.resources?.reservations?.devices ?? [];
      const gpuDevices = existingDevices.filter((d) => d.capabilities?.includes("gpu"));
      if (gpuDevices.length > 0) {
        overlayService.deploy = {
          ...(overlayService.deploy ?? {}),
          resources: {
            ...(overlayService.deploy?.resources ?? {}),
            reservations: { devices: gpuDevices },
          },
        };
      }
    }

    overlayServices[name] = overlayService;
  }

  // Include the vardo network declaration if any service uses it
  const hasVardoNetwork = Object.values(fullCompose.services).some((svc) =>
    svc.networks?.includes(networkName),
  );

  // Include externalized volume declarations for volumes that were in the
  // user's original compose (bareVolumeNames). These override the user's
  // bare declarations so Docker Compose uses the stable external volume.
  const overlayVolumes: Record<string, unknown> = {};
  for (const volName of bareVolumeNames) {
    if (volName in externalVolumes) {
      overlayVolumes[volName] = externalVolumes[volName];
    }
  }

  return {
    services: overlayServices,
    ...(hasVardoNetwork ? { networks: { [networkName]: { external: true } } } : {}),
    ...(Object.keys(overlayVolumes).length > 0 ? { volumes: overlayVolumes } : {}),
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

export function parsePortString(
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
// Host port stripping
// ---------------------------------------------------------------------------

/**
 * Remove host port bindings from a specific service.
 *
 * When Traefik handles routing for a service, host port mappings are
 * unnecessary and cause "port already allocated" conflicts. This strips
 * external port bindings while keeping internal-only expose declarations.
 *
 * Example: "8080:3000" → removed, "3000" → kept (internal only).
 */
export function stripHostPorts(
  compose: ComposeFile,
  serviceName: string,
): ComposeFile {
  const svc = compose.services[serviceName];
  if (!svc?.ports) return compose;

  const kept = svc.ports.filter((raw) => {
    const parsed = parsePortString(raw);
    // Keep entries that have no external (host) mapping
    return parsed && parsed.external === undefined;
  });

  const { ports: _, ...svcWithoutPorts } = svc;
  return {
    ...compose,
    services: {
      ...compose.services,
      [serviceName]: kept.length > 0
        ? { ...svcWithoutPorts, ports: kept }
        : svcWithoutPorts,
    },
  };
}

// ---------------------------------------------------------------------------
// Deploy transforms
// ---------------------------------------------------------------------------

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
  allowBindMounts?: boolean,
): ComposeFile | null {
  let compose: ComposeFile | null = null;

  if (app.deployType === "image" && app.composeContent) {
    // Imported container — use stored compose
    try {
      const parsed = parseCompose(app.composeContent);
      if (orgTrusted) {
        compose = parsed;
      } else {
        const { compose: sanitized } = sanitizeCompose(parsed, { allowBindMounts: allowBindMounts ?? false });
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
        const { compose: sanitized } = sanitizeCompose(parsed, { allowBindMounts: allowBindMounts ?? false });
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
