// Compose transforms applied at deploy: Traefik labels, networks, limits, GPUs, ports and the Vardo overlay.

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
import { isProjectNetwork } from "./project-network";
import { selectRoutedService } from "./routed-service";
import { sanitizeCompose, isAnonymousVolume } from "./compose-validate";
import { generateComposeForImage } from "./compose-generate";
import { DEFAULT_NETWORK } from "./shared-networks";
import { isHostname } from "@/lib/security/hostname";
import { VARDO_SELF_APP_NAME } from "@/lib/api/system-managed";
import { isPathPrefix, pathRoutePriority } from "@/lib/domains/path-prefix";
import { middlewareProblem, partitionMiddlewares } from "@/lib/domains/middlewares";
import type { QosTier } from "@/lib/resources/defaults";
import { tierCpuLimit, tierMemoryMb } from "@/lib/resources/host";

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

/** A service that routes itself: Vardo neither writes nor removes its Traefik labels. */
export function isTraefikSelfRouted(svc: ComposeService): boolean {
  return svc.labels?.[TRAEFIK_MANUAL_LABEL] === TRAEFIK_MANUAL_VALUE;
}

/** The user-owned labels on a self-routed service. */
function isSelfRoutedLabel(key: string): boolean {
  return key.startsWith(TRAEFIK_LABEL_PREFIX) || key === TRAEFIK_MANUAL_LABEL;
}

/**
 * Drop this app's Traefik routing labels from a non-routed service. Otherwise it becomes a
 * second backend and traffic round-robins into containers that serve nothing.
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
  // traefik.enable=true with no router still publishes under Traefik's default service name.
  const hasOwnRouter = Object.keys(kept).some((k) => k.startsWith("traefik.http.routers."));
  if (!hasOwnRouter && kept["traefik.enable"] === "true") delete kept["traefik.enable"];
  return kept;
}

// oom_score_adj for a critical-tier app with a memory limit. Must stay above -1000:
// an unkillable process deadlocks its container at its own cgroup limit.
const CRITICAL_OOM_WITH_LIMIT = -900;

export type { QosTier } from "@/lib/resources/defaults";

/** Memory cap (MB) when an app sets none. Sized by host memory; VARDO_DEFAULT_MEMORY_{TIER} overrides. */
export function defaultMemoryLimitMb(tier: QosTier): number {
  return tierMemoryMb(tier);
}

/** CPU cap (cores) when neither the app nor the compose sets one; null means none. VARDO_DEFAULT_CPUS_{TIER} overrides, 0 for none. */
export function defaultCpuLimit(tier: QosTier, hostCpus?: number): number | null {
  return tierCpuLimit(tier, hostCpus);
}

const DEFAULT_PIDS_LIMIT = 4096;

const NO_NEW_PRIVILEGES = "no-new-privileges";

/** Process cap per container when the compose sets none; null means none. Override with VARDO_DEFAULT_PIDS_LIMIT, 0 for none. */
export function defaultPidsLimit(): number | null {
  const override = process.env.VARDO_DEFAULT_PIDS_LIMIT;
  const parsed = override !== undefined && override !== "" ? Number(override) : NaN;
  if (Number.isInteger(parsed) && parsed >= 0) return parsed > 0 ? Math.max(parsed, 64) : null;
  return DEFAULT_PIDS_LIMIT;
}

/** Headers middleware options for an app's HTTPS router. Traefik overwrites any value the app sends. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  stsSeconds: "31536000",
  contentTypeNosniff: "true",
  customFrameOptionsValue: "SAMEORIGIN",
  referrerPolicy: "strict-origin-when-cross-origin",
};

/**
 * Add Traefik labels to one service and clear this app's routing labels from the rest.
 * Opted-out and self-routed services are left untouched.
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
    /** Traefik service name. Defaults to appName, then projectName. */
    traefikService?: string;
    /** Route only this path and below, e.g. "/docs". */
    pathPrefix?: string | null;
    /** Remove pathPrefix before forwarding. */
    stripPathPrefix?: boolean;
    /** Middlewares the domain asks for, ahead of Vardo's own. */
    middlewares?: string[];
    /** Add the default security headers to the HTTPS router. */
    securityHeaders?: boolean;
  },
): ComposeFile {
  const { projectName, domain, containerPort, certResolver = "le-dns", ssl = true } = opts;
  const pathPrefix = opts.pathPrefix || null;
  const serviceName =
    opts.serviceName ?? Object.keys(compose.services)[0];

  if (!serviceName || !compose.services[serviceName]) {
    throw new Error(
      `Service "${serviceName}" not found in compose file. Available: ${Object.keys(compose.services).join(", ")}`,
    );
  }

  // Backticks or spaces here would rewrite the Traefik rule and claim other hosts.
  if (!isHostname(domain)) throw new Error(`Refusing to route invalid domain "${domain}"`);
  if (pathPrefix && !isPathPrefix(pathPrefix)) throw new Error(`Refusing to route invalid path "${pathPrefix}"`);
  for (const ref of opts.middlewares ?? []) {
    // Trust is checked by the caller; this only keeps the label well-formed.
    if (middlewareProblem(ref, true)) throw new Error(`Refusing invalid middleware "${ref}"`);
  }

  const existing = compose.services[serviceName];
  if (isTraefikOptedOut(existing) || isTraefikSelfRouted(existing)) return compose;

  const isLocal = domain.endsWith(".localhost") || domain === "localhost";
  const isRedirect = !!opts.redirectTo;
  const permanent = (opts.redirectCode ?? 301) === 301;
  const svcName = opts.traefikService || opts.appName || projectName;
  const transportName = opts.appName || projectName;

  // Path and PathPrefix together stop "/docs" matching "/docsy".
  const rule = pathPrefix
    ? `Host(\`${domain}\`) && (Path(\`${pathPrefix}\`) || PathPrefix(\`${pathPrefix}/\`))`
    : `Host(\`${domain}\`)`;
  const labels: Record<string, string> = {
    ...existing.labels,
    "traefik.enable": "true",
    [`traefik.http.routers.${projectName}.rule`]: rule,
  };
  if (pathPrefix) labels[`traefik.http.routers.${projectName}.priority`] = String(pathRoutePriority(pathPrefix));

  // Middlewares on the router that serves the app: security headers, the domain's own, then the redirect or the path strip.
  const appMiddlewares: string[] = [];
  if (ssl && opts.securityHeaders) {
    for (const [option, value] of Object.entries(SECURITY_HEADERS)) {
      labels[`traefik.http.middlewares.${projectName}-headers.headers.${option}`] = value;
    }
    appMiddlewares.push(`${projectName}-headers`);
  }
  appMiddlewares.push(...(opts.middlewares ?? []));
  if (isRedirect) {
    // Redirect domain: redirectregex middleware, still TLS-terminated.
    labels[`traefik.http.middlewares.${projectName}-redirect.redirectregex.regex`] = "^https?://[^/]+(.*)$";
    labels[`traefik.http.middlewares.${projectName}-redirect.redirectregex.replacement`] = `${opts.redirectTo}\${1}`;
    labels[`traefik.http.middlewares.${projectName}-redirect.redirectregex.permanent`] = String(permanent);
    appMiddlewares.push(`${projectName}-redirect`);
    // Traefik requires a service reference even on redirect routers.
    labels[`traefik.http.routers.${projectName}.service`] = svcName;
  } else {
    if (pathPrefix && opts.stripPathPrefix) {
      labels[`traefik.http.middlewares.${projectName}-strip.stripprefix.prefixes`] = pathPrefix;
      appMiddlewares.push(`${projectName}-strip`);
    }
    labels[`traefik.http.services.${svcName}.loadbalancer.server.port`] = String(containerPort);
    labels[`traefik.http.routers.${projectName}.service`] = svcName;
    if (opts.backendProtocol === "https") {
      labels[`traefik.http.services.${svcName}.loadbalancer.server.scheme`] = "https";
      labels[`traefik.http.services.${svcName}.loadbalancer.serversTransport`] = `${transportName}-insecure@file`;
    }
  }

  if (ssl) {
    labels[`traefik.http.routers.${projectName}.entrypoints`] = "websecure";
    labels[`traefik.http.routers.${projectName}.tls`] = "true";

    // Local domains get Traefik's self-signed certs.
    if (!isLocal) {
      labels[`traefik.http.routers.${projectName}.tls.certresolver`] = certResolver;
    }

    // Port-80 router: redirects to HTTPS or the domain redirect target.
    labels[`traefik.http.routers.${projectName}-http.rule`] = rule;
    if (pathPrefix) labels[`traefik.http.routers.${projectName}-http.priority`] = String(pathRoutePriority(pathPrefix));
    labels[`traefik.http.routers.${projectName}-http.entrypoints`] = "web";
    labels[`traefik.http.routers.${projectName}-http.service`] = svcName;

    if (isRedirect) {
      labels[`traefik.http.routers.${projectName}-http.middlewares`] = `${projectName}-redirect`;
    } else {
      labels[`traefik.http.middlewares.${projectName}-https-redirect.redirectscheme.scheme`] = "https";
      labels[`traefik.http.middlewares.${projectName}-https-redirect.redirectscheme.permanent`] = "true";
      labels[`traefik.http.routers.${projectName}-http.middlewares`] = `${projectName}-https-redirect`;
    }
  } else {
    labels[`traefik.http.routers.${projectName}.entrypoints`] = "web";
  }
  if (appMiddlewares.length > 0) {
    labels[`traefik.http.routers.${projectName}.middlewares`] = appMiddlewares.join(",");
  }

  // stripHostPorts() handles host ports for the primary service.
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

/** injectTraefikLabels options a domain row decides. Middlewares the organization may not use are dropped. */
export function domainRouteOptions(domain: DeployTransformDomain, org: { trusted: boolean }) {
  return {
    middlewares: partitionMiddlewares(domain.middlewares, org.trusted).allowed,
    domain: domain.domain,
    certResolver: domain.certResolver || "le-dns",
    ssl: domain.sslEnabled ?? true,
    redirectTo: domain.redirectTo ?? undefined,
    redirectCode: domain.redirectCode ?? 301,
    pathPrefix: domain.pathPrefix ?? null,
    stripPathPrefix: domain.stripPathPrefix ?? false,
  };
}

/**
 * Strip Traefik labels from every service before re-injecting, so stale router names don't pile up.
 * Keeps `traefik.enable: "false"` and self-routed services.
 */
/**
 * Adds the security headers middleware to HTTPS routers an app declares in its own labels.
 * Run before Vardo injects its routers, which carry their own.
 */
export function injectHeadersIntoOwnRouters(compose: ComposeFile, appName: string): ComposeFile {
  // The console sets its own headers.
  if (appName === VARDO_SELF_APP_NAME) return compose;
  const middleware = `${appName}-vardo-headers`;
  const updatedServices: Record<string, ComposeService> = {};
  for (const [svcName, svc] of Object.entries(compose.services)) {
    const labels = svc.labels;
    if (!labels) {
      updatedServices[svcName] = svc;
      continue;
    }
    const routers = new Set<string>();
    for (const key of Object.keys(labels)) {
      const m = /^traefik\.http\.routers\.([^.]+)\.rule$/i.exec(key);
      if (m) routers.add(m[1]);
    }
    const https = [...routers].filter((r) => {
      const tls = Object.keys(labels).some((k) => k.toLowerCase().startsWith(`traefik.http.routers.${r.toLowerCase()}.tls`));
      const entry = labels[`traefik.http.routers.${r}.entrypoints`] ?? "";
      return tls || /websecure/i.test(entry);
    });
    if (https.length === 0) {
      updatedServices[svcName] = svc;
      continue;
    }
    const next: Record<string, string> = { ...labels };
    for (const [option, value] of Object.entries(SECURITY_HEADERS)) {
      next[`traefik.http.middlewares.${middleware}.headers.${option}`] = value;
    }
    for (const r of https) {
      const key = `traefik.http.routers.${r}.middlewares`;
      const current = (next[key] ?? "").split(",").map((m) => m.trim()).filter(Boolean);
      if (!current.includes(middleware)) next[key] = [middleware, ...current].join(",");
    }
    updatedServices[svcName] = { ...svc, labels: next };
  }
  return { ...compose, services: updatedServices };
}

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

export { slotComposeFiles } from "./slot-files";

/**
 * Strip Vardo-injected labels and network, leaving the user's standalone compose.
 * Keeps `traefik.enable: "false"` and self-routed Traefik blocks.
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
    const strippedNetworks = svc.networks?.filter((n) => n !== networkName && !isProjectNetwork(n));
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
        ([k]) => k !== networkName && !isProjectNetwork(k),
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

/** Remove named services and their depends_on references. */
export function excludeServices(
  compose: ComposeFile,
  serviceNames: string[]
): ComposeFile {
  const excluded = new Set(serviceNames);
  const filteredServices: Record<string, ComposeService> = {};

  for (const [name, svc] of Object.entries(compose.services)) {
    if (excluded.has(name)) continue;

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

/** Build docker-compose.override.yml holding only Vardo-injected config. */
export function buildVardoOverlay(opts: {
  fullCompose: ComposeFile;
  networkName: string;
  /** The project network, carried over with the default network it was attached alongside. */
  projectNetwork?: string | null;
  cpuLimit?: number | null;
  memoryLimit?: number | null;
  /** Burstable baseline in MB, under deploy.resources.reservations. */
  memoryReservation?: number | null;
  gpuEnabled?: boolean;
  /** QoS tier, compiled into oom_score_adj, memory reservation and cpu_shares. */
  priority?: "critical" | "standard" | "disposable" | null;
  externalVolumes?: Record<string, unknown>;
  bareVolumeNames?: string[];
  /** Per-service exposed ports from child app rows. */
  serviceExposedPorts?: Record<string, { internal: number; external?: number; protocol?: string }[]>;
  /** Per-service config from child app rows; overrides the parent's limits and GPU. (#745) */
  serviceConfig?: Record<string, ServiceConfigOverride>;
  /** Resolved per-service env vars from child apps; override same-named compose keys. */
  serviceEnv?: Record<string, Record<string, string>>;
  /** Cores the tier CPU default is sized from. Defaults to this host's. */
  hostCpus?: number;
  /** Untrusted organizations get no-new-privileges on every service. */
  orgTrusted?: boolean;
  /** Mounts the app's certificate volume read-only at /certs in these services. */
  certMount?: { services: string[]; volume: string };
  /** Vardo's own infrastructure: no tier limits, cpu_shares or oom_score_adj. */
  infraServices?: ReadonlySet<string>;
}): ComposeFile {
  const {
    fullCompose,
    networkName,
    cpuLimit,
    memoryLimit,
    memoryReservation,
    gpuEnabled,
    priority = "standard",
    externalVolumes = {},
    bareVolumeNames = [],
    serviceExposedPorts = {},
    serviceConfig = {},
    serviceEnv = {},
    hostCpus,
    orgTrusted = true,
  } = opts;

  const overlayServices: Record<string, ComposeService> = {};
  for (const [name, svc] of Object.entries(fullCompose.services)) {
    // A self-routed service's Traefik block stays in the base file.
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

    // The overlay restates `default` so merging it over the bare file keeps the service there.
    const owned = [networkName, opts.projectNetwork].filter((n): n is string => !!n && !!svc.networks?.includes(n));
    const vardoNetworks = owned.length > 0
      ? svc.networks!.filter((n) => n === DEFAULT_NETWORK || owned.includes(n))
      : undefined;

    const overlayService: ComposeService = { name };

    const cfg = serviceConfig[name];
    const effCpuLimit = cfg ? cfg.cpuLimit : cpuLimit;
    const explicitMemoryLimit = cfg ? cfg.memoryLimit : memoryLimit;
    const burstReservation = cfg ? cfg.memoryReservation : memoryReservation;
    const effGpuEnabled = cfg ? cfg.gpuEnabled : gpuEnabled;
    const effPriority = cfg ? cfg.priority : priority;
    const tier = effPriority ?? "standard";
    // App limit, then compose limit, then tier default. Explicit 0 means no cap.
    const declaredMemory = svc.deploy?.resources?.limits?.memory;
    const effMemory =
      explicitMemoryLimit == null
        ? declaredMemory ?? `${defaultMemoryLimitMb(tier)}M`
        : explicitMemoryLimit > 0
          ? `${explicitMemoryLimit}M`
          : undefined;
    const declaredCpus = svc.deploy?.resources?.limits?.cpus;
    const tierCpus = defaultCpuLimit(tier, hostCpus);
    // App limit (0 is none, leaving the compose's), then compose limit (0 is none), then tier default.
    const effCpus =
      effCpuLimit == null
        ? declaredCpus !== undefined
          ? String(declaredCpus)
          : tierCpus
            ? String(tierCpus)
            : undefined
        : effCpuLimit > 0
          ? String(effCpuLimit)
          : undefined;
    const effPids = svc.deploy?.resources?.limits?.pids ?? defaultPidsLimit() ?? undefined;

    if (vardoLabels && Object.keys(vardoLabels).length > 0) {
      overlayService.labels = vardoLabels;
    }
    if (vardoNetworks) {
      overlayService.networks = vardoNetworks;
    }

    // The normalized restart policy only reaches the container through the overlay.
    if (svc.restart) {
      overlayService.restart = svc.restart;
    }

    if (!orgTrusted && !svc.security_opt?.some((o) => o.startsWith(NO_NEW_PRIVILEGES))) {
      overlayService.security_opt = [`${NO_NEW_PRIVILEGES}:true`];
    }

    const infra = opts.infraServices?.has(name) ?? false;

    if (!infra && (effCpus || effMemory || effPids !== undefined)) {
      const limits: ResourceLimits = {};
      if (effCpus) limits.cpus = effCpus;
      if (effMemory) limits.memory = effMemory;
      if (effPids !== undefined) limits.pids = effPids;
      overlayService.deploy = {
        ...(overlayService.deploy ?? {}),
        resources: {
          ...(overlayService.deploy?.resources ?? {}),
          limits: { ...(overlayService.deploy?.resources?.limits ?? {}), ...limits },
        },
      };
    }

    // Memory reservation goes under deploy.resources.reservations: Compose rejects a top-level
    // mem_reservation alongside a reservations block.
    let memReservation: string | undefined;
    if (infra) {
      // Its own compose file sets what it needs.
    } else if (tier === "critical") {
      overlayService.oom_score_adj = CRITICAL_OOM_WITH_LIMIT;
      overlayService.cpu_shares = 2048;
      // Reserve only an explicit limit; a tier default is a cap.
      if (explicitMemoryLimit) memReservation = `${explicitMemoryLimit}M`;
    } else if (tier === "disposable") {
      overlayService.oom_score_adj = 750;
      overlayService.cpu_shares = 256;
    } else {
      overlayService.oom_score_adj = 0;
      overlayService.cpu_shares = 1024;
    }
    if (!infra && burstReservation) memReservation = `${burstReservation}M`;

    const svcPorts = serviceExposedPorts[name];
    if (svcPorts && svcPorts.length > 0) {
      overlayService.ports = svcPorts
        .filter((p) => p.external)
        .map((p) => `${p.external}:${p.internal}${p.protocol ? `/${p.protocol}` : ""}`);
    }

    // GPU devices and memory reservation share one reservations object.
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

    if (opts.certMount?.services.includes(name)) {
      overlayService.volumes = ["vardo-certs:/certs:ro"];
    }

    const svcEnv = serviceEnv[name];
    if (svcEnv && Object.keys(svcEnv).length > 0) {
      overlayService.environment = { ...svcEnv };
    }

    overlayServices[name] = overlayService;
  }

  const usedExternal = [networkName, opts.projectNetwork].filter(
    (n): n is string => !!n && Object.values(fullCompose.services).some((svc) => svc.networks?.includes(n)),
  );

  // External declarations override the user's bare volume declarations.
  const overlayVolumes: Record<string, unknown> = {};
  for (const volName of bareVolumeNames) {
    if (volName in externalVolumes) {
      overlayVolumes[volName] = externalVolumes[volName];
    }
  }

  if (opts.certMount) {
    overlayVolumes["vardo-certs"] = { external: true, name: opts.certMount.volume };
  }

  return {
    services: overlayServices,
    ...(usedExternal.length > 0
      ? { networks: Object.fromEntries(usedExternal.map((n) => [n, { external: true }])) }
      : {}),
    ...(Object.keys(overlayVolumes).length > 0 ? { volumes: overlayVolumes } : {}),
  };
}

/**
 * Attach services to an external network: those in `attachTo`, else every bridge-mode service.
 * Non-routed services stay private so their aliases can't collide across apps on vardo-network.
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
    // Naming any network drops the implicit default, which siblings and shared services resolve on.
    const existingNetworks = svc.networks?.length ? svc.networks : [DEFAULT_NETWORK];
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

/** Services labeled `traefik.enable=true`. */
export function getTraefikRoutedServices(compose: ComposeFile): Set<string> {
  const routed = new Set<string>();
  for (const [name, svc] of Object.entries(compose.services)) {
    const labels = svc.labels;
    if (!labels) continue;
    const enable = labels["traefik.enable"];
    if (enable === "true" || (enable as unknown) === true) {
      routed.add(name);
    }
  }
  return routed;
}

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

/**
 * Reserve all NVIDIA GPUs for services. Skips services with named volumes by default;
 * existing GPU reservations are kept.
 */
export function injectGpuDevices(
  compose: ComposeFile,
  opts?: { skip?: Set<string>; include?: Set<string> },
): ComposeFile {
  // `include` is an explicit allow-list and bypasses the skip set.
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

/** Services mounting a top-level named volume, which is externalized at deploy. */
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

/** Port mappings from every service in a compose file. */
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
  const stripped = raw.split("/")[0];
  // `${VAR:-default}` holds a colon that isn't a port separator.
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

/** Remove a service's host port bindings ("port already allocated" conflicts); internal-only ports stay. */
export function stripHostPorts(
  compose: ComposeFile,
  serviceName: string,
): ComposeFile {
  const svc = compose.services[serviceName];
  if (!svc?.ports) return compose;

  const kept = svc.ports.filter((raw) => {
    const parsed = parsePortString(raw);
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

/** Apply the deploy transform chain: limits, GPUs, Traefik labels and vardo-network. */
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
    orgTrusted?: boolean;
    securityHeaders?: boolean;
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

  if (!allServicesCustomNetwork && opts.domains.length > 0) result = stripTraefikLabels(result);
  if (opts.securityHeaders ?? true) result = injectHeadersIntoOwnRouters(result, opts.appName);

  if (!allServicesCustomNetwork && opts.domains.length > 0) {
    // Vardo owns routing once the app has a domain.

    for (const domain of opts.domains) {
      const port = domain.port || opts.containerPort || 3000;
      const resolvedProtocol = resolveBackendProtocol(opts.backendProtocol, port);
      const targetService = selectRoutedService(result, {
        containerPort: port,
        override: domain.serviceName,
      }).service;
      result = injectTraefikLabels(result, {
        ...domainRouteOptions(domain, { trusted: opts.orgTrusted ?? false }),
        projectName: `${opts.appName}-${domain.id.slice(0, 6)}`,
        appName: opts.appName,
        containerPort: port,
        serviceName: targetService,
        backendProtocol: resolvedProtocol,
        securityHeaders: opts.securityHeaders ?? true,
      });
    }
  }

  // Only routed services join vardo-network; an empty set attaches nothing.
  // Attaching everything causes DNS alias collisions across apps.
  const routed = getTraefikRoutedServices(result);
  result = injectNetwork(result, opts.networkName, { attachTo: routed });

  return result;
}

/** Runtime compose preview from stored config. Null for git apps without stored compose. */
export function buildComposePreview(
  app: ComposePreviewApp,
  volumesList: { name: string; mountPath: string }[],
  networkName: string,
  orgTrusted?: boolean,
  allowBindMounts?: boolean,
): ComposeFile | null {
  let compose: ComposeFile | null = null;

  if (app.deployType === "image" && app.composeContent) {
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
    orgTrusted,
    securityHeaders: app.securityHeaders,
  });
}
