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
  ServiceConfigOverride,
} from "./compose-types";
import { TRAEFIK_LABEL_PREFIX, resolveBackendProtocol } from "./compose-generate";
import { parseCompose } from "./compose-parse";
import { selectRoutedService } from "./routed-service";
import { sanitizeCompose, isAnonymousVolume } from "./compose-validate";
import { generateComposeForImage } from "./compose-generate";

const VARDO_LABEL_PREFIX = "vardo.";

/** Label a service sets to declare its own Traefik routing. */
export const TRAEFIK_MANUAL_LABEL = "vardo.traefik";
const TRAEFIK_MANUAL_VALUE = "manual";

/** The one Traefik label Vardo never writes and never removes. */
function isOptOutLabel(key: string, value: unknown): boolean {
  return key === "traefik.enable" && (value === "false" || value === false);
}

/** A service the user has explicitly opted out of Traefik routing. */
export function isTraefikOptedOut(svc: ComposeService): boolean {
  return isOptOutLabel("traefik.enable", svc.labels?.["traefik.enable"]);
}

/**
 * A service that routes itself: Vardo generates no Traefik labels for it and
 * removes none, so hand-written routers survive a deploy intact. The opt-out
 * above says "never routed"; this one says "routed, but not by Vardo".
 */
export function isTraefikSelfRouted(svc: ComposeService): boolean {
  return svc.labels?.[TRAEFIK_MANUAL_LABEL] === TRAEFIK_MANUAL_VALUE;
}

/** On a self-routed service, the labels that belong to the user rather than Vardo. */
function isSelfRoutedLabel(key: string): boolean {
  return key.startsWith(TRAEFIK_LABEL_PREFIX) || key === TRAEFIK_MANUAL_LABEL;
}

/**
 * Drop this app's Traefik routing labels from a service that is not the routed
 * one. Vardo's Traefik service is app-scoped, so a second service carrying the
 * same labels becomes a second backend and traffic round-robins into containers
 * that serve nothing on the port.
 */
function dropAppRouting(
  labels: Record<string, string> | undefined,
  opts: { serviceLabel: string; routerPrefix: string },
): Record<string, string> | undefined {
  if (!labels) return labels;
  const owned = (k: string) =>
    k.startsWith(`traefik.http.services.${opts.serviceLabel}.`) ||
    k.startsWith(`traefik.http.routers.${opts.routerPrefix}.`) ||
    k.startsWith(`traefik.http.routers.${opts.routerPrefix}-http.`) ||
    k.startsWith(`traefik.http.middlewares.${opts.routerPrefix}-`);
  const kept = Object.fromEntries(Object.entries(labels).filter(([k]) => !owned(k)));
  // Leaving traefik.enable=true on a service with no router of its own would
  // still publish it under Traefik's default service name.
  const hasOwnRouter = Object.keys(kept).some((k) => k.startsWith("traefik.http.routers."));
  if (!hasOwnRouter && kept["traefik.enable"] === "true") delete kept["traefik.enable"];
  return kept;
}

// oom_score_adj for a critical-tier app that ALSO has a hard memory limit.
// Must be > -1000: a value of exactly -1000 makes the process unkillable, which
// deadlocks the container when it hits its own cgroup memory limit (see the
// critical-tier branch in buildVardoOverlay). -900 keeps it strongly protected
// from the host OOM killer (well below standard=0 / disposable=750) while still
// allowing the kernel to reclaim at the cgroup boundary.
const CRITICAL_OOM_WITH_LIMIT = -900;

// Memory cap (MB) applied when an app has no explicit limit. Without a cgroup
// limit a container can take the whole host, and a JVM sizes its heap from the
// hypervisor's RAM rather than the LXC's — stirling-pdf read 64GB on a 24GB
// guest and asked for a 32GB heap. Override per tier with
// VARDO_DEFAULT_MEMORY_{CRITICAL,STANDARD,DISPOSABLE}.
const TIER_MEMORY_DEFAULTS_MB = {
  critical: 2048,
  standard: 1024,
  disposable: 512,
} as const;

export type QosTier = "critical" | "standard" | "disposable";

export function defaultMemoryLimitMb(tier: QosTier): number {
  const override = process.env[`VARDO_DEFAULT_MEMORY_${tier.toUpperCase()}`];
  const parsed = override ? parseInt(override, 10) : NaN;
  if (!isNaN(parsed) && parsed >= 64) return parsed;
  return TIER_MEMORY_DEFAULTS_MB[tier];
}

// ---------------------------------------------------------------------------
// Traefik label injection
// ---------------------------------------------------------------------------

/**
 * Add Traefik reverse-proxy labels to a service in the compose file, and clear
 * this app's routing labels from every other service so exactly one backend
 * declares the app's Traefik service.
 *
 * A service carrying `traefik.enable: "false"` is never routed and never
 * relabeled — the opt-out is the user's, not Vardo's to overwrite. A service
 * marked `vardo.traefik: "manual"` is skipped for the same reason: it declares
 * its own routers.
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
  const { projectName, domain, containerPort, certResolver = "le-dns", ssl = true } = opts;
  const serviceName =
    opts.serviceName ?? Object.keys(compose.services)[0];

  if (!serviceName || !compose.services[serviceName]) {
    throw new Error(
      `Service "${serviceName}" not found in compose file. Available: ${Object.keys(compose.services).join(", ")}`,
    );
  }

  const existing = compose.services[serviceName];
  if (isTraefikOptedOut(existing) || isTraefikSelfRouted(existing)) return compose;

  const isLocal = domain.endsWith(".localhost") || domain === "localhost";
  const isRedirect = !!opts.redirectTo;
  const permanent = (opts.redirectCode ?? 301) === 301;
  const svcName = opts.appName || projectName;

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
    labels[`traefik.http.routers.${projectName}.service`] = svcName;
  } else {
    // Normal domain — route to the app container
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
    labels[`traefik.http.routers.${projectName}-http.service`] = svcName;

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
  const updatedServices: Record<string, ComposeService> = {};
  for (const [name, svc] of Object.entries(compose.services)) {
    if (name === serviceName) {
      updatedServices[name] = { ...existing, labels };
      continue;
    }
    if (isTraefikSelfRouted(svc)) {
      updatedServices[name] = svc;
      continue;
    }
    const pruned = dropAppRouting(svc.labels, {
      serviceLabel: svcName,
      routerPrefix: projectName,
    });
    updatedServices[name] = pruned ? { ...svc, labels: pruned } : svc;
  }

  return { ...compose, services: updatedServices };
}

// ---------------------------------------------------------------------------
// Traefik label stripping
// ---------------------------------------------------------------------------

/**
 * Strip Vardo-injectable Traefik labels from every service in the compose file.
 * Used before re-injecting fresh Traefik config to prevent stale router names
 * from accumulating (e.g. "appname" from import vs "appname-abc123" from deploy).
 * An explicit `traefik.enable: "false"` survives — it is the user's opt-out, and
 * the selection and injection steps both read it. A self-routed service is left
 * whole: its routers are hand-written, so there is no stale Vardo name to clear.
 * Returns a new ComposeFile — does not mutate the original.
 */
export function stripTraefikLabels(compose: ComposeFile): ComposeFile {
  const updatedServices: Record<string, ComposeService> = {};
  for (const [svcName, svc] of Object.entries(compose.services)) {
    if (!svc.labels || isTraefikSelfRouted(svc)) {
      updatedServices[svcName] = svc;
      continue;
    }
    const stripped = Object.fromEntries(
      Object.entries(svc.labels).filter(
        ([k, v]) => !k.startsWith(TRAEFIK_LABEL_PREFIX) || isOptOutLabel(k, v),
      )
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
 * services. An explicit `traefik.enable: "false"` is the user's own label and
 * survives, as does a self-routed service's whole Traefik block. Used to write
 * the user-facing docker-compose.yml that can be run standalone without Vardo.
 * Returns a new ComposeFile — does not mutate the original.
 */
export function stripVardoInjections(
  compose: ComposeFile,
  networkName: string = "vardo-network",
): ComposeFile {
  const updatedServices: Record<string, ComposeService> = {};
  for (const [name, svc] of Object.entries(compose.services)) {
    const selfRouted = isTraefikSelfRouted(svc);
    const strippedLabels = svc.labels
      ? Object.fromEntries(
          Object.entries(svc.labels).filter(
            ([k, v]) =>
              isOptOutLabel(k, v) ||
              (selfRouted && isSelfRoutedLabel(k)) ||
              (!k.startsWith(TRAEFIK_LABEL_PREFIX) && !k.startsWith(VARDO_LABEL_PREFIX)),
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
  /** QoS tier — compiled into oom_score_adj/mem_reservation/cpu_shares. */
  priority?: "critical" | "standard" | "disposable" | null;
  externalVolumes?: Record<string, unknown>;
  bareVolumeNames?: string[];
  /** Per-service exposed ports from child app DB records (service name → ports). */
  serviceExposedPorts?: Record<string, { internal: number; external?: number; protocol?: string }[]>;
  /**
   * Per-service config from decomposed child app rows (service name → override).
   * When a service has an entry, its resources/GPU come from the child instead
   * of the parent-global cpuLimit/memoryLimit/gpuEnabled. (#745)
   */
  serviceConfig?: Record<string, ServiceConfigOverride>;
  /**
   * Per-service env vars set on a decomposed child app (service name → resolved
   * key/value map). Injected into that service's `environment:`, overriding any
   * same-named key declared in the user's compose. Values are already resolved
   * (templates/secrets). Empty for non-decomposed apps. (decomposed-children)
   */
  serviceEnv?: Record<string, Record<string, string>>;
}): ComposeFile {
  const {
    fullCompose,
    networkName,
    cpuLimit,
    memoryLimit,
    gpuEnabled,
    priority = "standard",
    externalVolumes = {},
    bareVolumeNames = [],
    serviceExposedPorts = {},
    serviceConfig = {},
    serviceEnv = {},
  } = opts;

  const overlayServices: Record<string, ComposeService> = {};
  for (const [name, svc] of Object.entries(fullCompose.services)) {
    // A self-routed service's Traefik block stays in the base file, where
    // stripVardoInjections left it — copying it here would duplicate it.
    const selfRouted = isTraefikSelfRouted(svc);
    const vardoLabels = svc.labels
      ? Object.fromEntries(
          Object.entries(svc.labels).filter(
            ([k]) =>
              (k.startsWith(TRAEFIK_LABEL_PREFIX) || k.startsWith(VARDO_LABEL_PREFIX)) &&
              !(selfRouted && isSelfRoutedLabel(k)),
          ),
        )
      : undefined;

    const vardoNetworks = svc.networks?.includes(networkName) ? [networkName] : undefined;

    const overlayService: ComposeService = { name };

    // Per-service config from a decomposed child app overrides the parent
    // globals; services without a child entry use the parent's values (#745).
    const cfg = serviceConfig[name];
    const effCpuLimit = cfg ? cfg.cpuLimit : cpuLimit;
    const explicitMemoryLimit = cfg ? cfg.memoryLimit : memoryLimit;
    const effGpuEnabled = cfg ? cfg.gpuEnabled : gpuEnabled;
    const effPriority = cfg ? cfg.priority : priority;
    const tier = effPriority ?? "standard";
    // Memory precedence: the app's own limit, then one the compose file declares
    // (parseCompose folds mem_limit into this field), then the tier default.
    // An explicit 0 means no cap.
    const declaredMemory = svc.deploy?.resources?.limits?.memory;
    const effMemory =
      explicitMemoryLimit == null
        ? declaredMemory ?? `${defaultMemoryLimitMb(tier)}M`
        : explicitMemoryLimit > 0
          ? `${explicitMemoryLimit}M`
          : undefined;

    if (vardoLabels && Object.keys(vardoLabels).length > 0) {
      overlayService.labels = vardoLabels;
    }
    if (vardoNetworks) {
      overlayService.networks = vardoNetworks;
    }

    // Restart policy resolved by compose-normalize. The base file keeps the
    // author's own value; without it here the container never receives one.
    if (svc.restart) {
      overlayService.restart = svc.restart;
    }

    // App-level resource limits set via Vardo UI (not from the user's compose)
    if (effCpuLimit || effMemory) {
      const limits: ResourceLimits = {};
      if (effCpuLimit) limits.cpus = String(effCpuLimit);
      if (effMemory) limits.memory = effMemory;
      overlayService.deploy = {
        ...(overlayService.deploy ?? {}),
        resources: {
          ...(overlayService.deploy?.resources ?? {}),
          limits: { ...(overlayService.deploy?.resources?.limits ?? {}), ...limits },
        },
      };
    }

    // QoS tier → runtime knobs. oom_score_adj and cpu_shares are top-level
    // compose service fields (honored by `docker compose up` v2 non-swarm; they
    // have no deploy.resources equivalent). The memory reservation, however,
    // must go under deploy.resources.reservations.memory rather than a top-level
    // mem_reservation — Compose rejects a top-level mem_reservation alongside a
    // deploy.resources.reservations block (which GPU apps already carry for
    // devices). It is merged with any GPU devices below.
    let memReservation: string | undefined;
    if (tier === "critical") {
      // Every service now carries a memory limit, so -1000 is never safe here:
      // an unkillable process deadlocks its own cgroup at the limit.
      overlayService.oom_score_adj = CRITICAL_OOM_WITH_LIMIT;
      overlayService.cpu_shares = 2048;
      // Reserve only what the operator explicitly asked for — a tier default is
      // a cap, not a claim on the host's memory.
      if (explicitMemoryLimit) memReservation = `${explicitMemoryLimit}M`;
    } else if (tier === "disposable") {
      overlayService.oom_score_adj = 750;
      overlayService.cpu_shares = 256;
    } else {
      overlayService.oom_score_adj = 0;
      overlayService.cpu_shares = 1024;
    }

    // Exposed ports from child app UI settings
    const svcPorts = serviceExposedPorts[name];
    if (svcPorts && svcPorts.length > 0) {
      overlayService.ports = svcPorts
        .filter((p) => p.external)
        .map((p) => `${p.external}:${p.internal}${p.protocol ? `/${p.protocol}` : ""}`);
    }

    // Reservations block: GPU devices (Vardo UI setting) + the critical-tier
    // memory reservation. Both live under deploy.resources.reservations and are
    // merged into one object so neither clobbers the other (and so we never emit
    // a conflicting top-level mem_reservation).
    const reservations: NonNullable<
      NonNullable<ComposeService["deploy"]>["resources"]
    >["reservations"] = {
      ...(overlayService.deploy?.resources?.reservations ?? {}),
    };
    if (effGpuEnabled) {
      const existingDevices = svc.deploy?.resources?.reservations?.devices ?? [];
      const gpuDevices = existingDevices.filter((d) => d.capabilities?.includes("gpu"));
      if (gpuDevices.length > 0) reservations.devices = gpuDevices;
    }
    if (memReservation) reservations.memory = memReservation;
    if (reservations.devices?.length || reservations.memory) {
      overlayService.deploy = {
        ...(overlayService.deploy ?? {}),
        resources: {
          ...(overlayService.deploy?.resources ?? {}),
          reservations,
        },
      };
    }

    // Per-service env vars from a decomposed child app. Merged as an override
    // file `environment:` map, so these keys win over the same key in the user's
    // compose while leaving the rest of that service's environment intact.
    const svcEnv = serviceEnv[name];
    if (svcEnv && Object.keys(svcEnv).length > 0) {
      overlayService.environment = { ...svcEnv };
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
 * Add an external network to the compose file and attach services to it.
 *
 * By default, every bridge-mode service is attached — backwards-compatible
 * behaviour for the few callers (import, adopt) that pre-date routing-aware
 * injection. The deploy pipeline passes an explicit `attachTo` set listing
 * only the services that actually need to be reachable from vardo-traefik
 * (i.e. services carrying Traefik router labels).
 *
 * Non-routed services (databases, caches, workers, sidecars) stay on the
 * compose project's private network so that their per-project service
 * aliases (e.g. `postgres`, `redis`) cannot collide with identically-named
 * services in sibling vardo apps sharing `vardo-network`.
 *
 * Returns a new ComposeFile -- does not mutate the original.
 */
export function injectNetwork(
  compose: ComposeFile,
  networkName: string = "vardo-network",
  opts?: { attachTo?: Set<string> },
): ComposeFile {
  const attachTo = opts?.attachTo;
  const updatedServices: Record<string, ComposeService> = {};
  for (const [key, svc] of Object.entries(compose.services)) {
    if (svc.network_mode) {
      updatedServices[key] = svc;
      continue;
    }
    if (attachTo && !attachTo.has(key)) {
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

/**
 * Return the set of services carrying a `traefik.enable=true` label. These
 * are the services the shared `vardo-network` must reach so vardo-traefik
 * can route traffic to them.
 */
export function getTraefikRoutedServices(compose: ComposeFile): Set<string> {
  const routed = new Set<string>();
  for (const [name, svc] of Object.entries(compose.services)) {
    const labels = svc.labels;
    if (!labels) continue;
    // Accept both the canonical "true" and the rare boolean form.
    const enable = labels["traefik.enable"];
    if (enable === "true" || (enable as unknown) === true) {
      routed.add(name);
    }
  }
  return routed;
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
 * Inject NVIDIA GPU access into services in a compose file via
 * deploy.resources.reservations.devices. Uses `count: all` so every
 * available GPU is accessible. Returns a new ComposeFile — does not
 * mutate the original.
 *
 * By default, services that mount a top-level named volume (i.e. are
 * "stateful" in the same sense as the blue/green swap uses) are skipped,
 * because databases, caches, and similar infrastructure almost never
 * need GPU access and the reservation adds runtime overhead plus
 * schedules the service on nodes with GPU capacity for no reason. A
 * service that actually needs GPU + a named volume can either opt in by
 * declaring its own GPU reservation in the source compose (the function
 * preserves those), or the caller can pass an explicit `skip` set.
 */
export function injectGpuDevices(
  compose: ComposeFile,
  opts?: { skip?: Set<string>; include?: Set<string> },
): ComposeFile {
  // `include` is an explicit allow-list (e.g. per-service GPU toggled on a
  // decomposed child): when present, ONLY those services get devices and the
  // stateful-skip heuristic is bypassed — the user asked for it on that
  // service specifically. Otherwise fall back to skip-based injection.
  const include = opts?.include;
  const skip = opts?.skip ?? getServicesWithExternalizedVolumes(compose);
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
    const excluded = include ? !include.has(key) : skip.has(key);
    if (excluded) {
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

/**
 * Return the set of services that mount a top-level named volume that
 * will be externalized at deploy time. This is the same set the blue/
 * green swap must stop before cutover (because an externalized volume
 * can't be held open by two containers at once), and also the default
 * skip set for GPU injection (because databases don't need GPUs).
 *
 * Anonymous volumes (64-char hex names that Docker generates) and bind
 * mounts are excluded — externalization only applies to named volumes
 * that the user declared at the top level of the compose file.
 *
 * Callers needing this set for DIFFERENT reasons (safety vs. heuristic)
 * should call this helper directly — the name reflects the mechanical
 * property being computed, not the reason any particular caller wants
 * it. If the two use cases ever diverge (e.g. GPU skip grows an image-
 * name heuristic), introduce a separate helper at that point rather
 * than generalizing this one.
 */
export function getServicesWithExternalizedVolumes(
  compose: ComposeFile,
): Set<string> {
  const matched = new Set<string>();
  const namedVolumes = new Set(
    Object.keys(compose.volumes ?? {}).filter((v) => !isAnonymousVolume(v)),
  );
  if (namedVolumes.size === 0) return matched;
  for (const [name, svc] of Object.entries(compose.services)) {
    const mounts = svc.volumes ?? [];
    const usesNamedVolume = mounts.some((m) => {
      const src = m.split(":")[0];
      return namedVolumes.has(src);
    });
    if (usesNamedVolume) matched.add(name);
  }
  return matched;
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

/** Split on `:`, ignoring any inside a `${...}` interpolation. */
function splitOutsideInterpolation(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "$" && value[i + 1] === "{") depth++;
    else if (char === "}" && depth > 0) depth--;
    if (char === ":" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

export function parsePortString(
  raw: string,
): { internal: number; external?: number } | null {
  // Strip protocol suffix (e.g. /tcp, /udp)
  const stripped = raw.split("/")[0];
  // `${VAR:-default}` carries a colon that is not a port separator, and
  // splitting on it read the default as a negative host port.
  const parts = splitOutsideInterpolation(stripped);

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

  if (!allServicesCustomNetwork && opts.domains.length > 0) {
    // Vardo owns routing once the app has a domain — drop any inbound Traefik
    // labels so they can't declare a second backend for the same service name.
    result = stripTraefikLabels(result);

    for (const domain of opts.domains) {
      const port = domain.port || opts.containerPort || 3000;
      const resolvedProtocol = resolveBackendProtocol(opts.backendProtocol, port);
      // A domain scoped to a compose service (added on a child app) routes to
      // that service; otherwise pick the service that serves the port.
      const targetService = selectRoutedService(result, {
        containerPort: port,
        override: domain.composeService,
      }).service;
      result = injectTraefikLabels(result, {
        projectName: `${opts.appName}-${domain.id.slice(0, 6)}`,
        appName: opts.appName,
        domain: domain.domain,
        containerPort: port,
        certResolver: domain.certResolver || "le-dns",
        ssl: domain.sslEnabled ?? true,
        redirectTo: domain.redirectTo ?? undefined,
        redirectCode: domain.redirectCode ?? 301,
        serviceName: targetService,
        backendProtocol: resolvedProtocol,
      });
    }
  }

  // Only attach vardo-network to services that will actually be routed by
  // vardo-traefik. Non-routed services (databases, workers, etc.) stay on
  // the compose project's private network — this prevents DNS alias
  // collisions between identically-named services in sibling apps. If no
  // service is Traefik-routed (worker-only stacks, no ingress), we pass
  // an empty set so NOTHING joins vardo-network — the historical fallback
  // of "attach everywhere" is exactly what caused the agents outage.
  const routed = getTraefikRoutedServices(result);
  result = injectNetwork(result, opts.networkName, { attachTo: routed });

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
