// ---------------------------------------------------------------------------
// Deploy Steps 2-3: Port detection, Traefik label injection, network injection,
// GPU injection, and app labels.
// ---------------------------------------------------------------------------

import {
  injectTraefikLabels,
  injectNetwork,
  resolveBackendProtocol,
  narrowBackendProtocol,
  injectGpuDevices,
  detectStatefulInfrastructureServices,
  stripVardoInjections,
  getTraefikRoutedServices,
} from "../compose";
import { detectExposedPorts } from "../client";
import { normalizeCompose, getRoutedServices } from "../compose-normalize";
import { removeAppRouteConfig } from "@/lib/ssl/generate-config";
import {
  NETWORK_NAME as VARDO_NETWORK,
  DEFAULT_CONTAINER_PORT,
} from "../constants";
import type { DeployContext } from "../deploy-context";

const NETWORK_NAME = VARDO_NETWORK;

export async function resolveCompose(ctx: DeployContext): Promise<DeployContext> {
  const { app, log, envMap } = ctx;
  let compose = ctx.compose;

  // Capture the bare compose before any Vardo injections. Strip any
  // existing Traefik/vardo labels that came in via import.
  const bareCompose = stripVardoInjections(compose, NETWORK_NAME);
  ctx.bareCompose = bareCompose;

  // Normalize: treat the user's compose as intent, produce safe runtime config.
  const routedServices = getRoutedServices(compose, app.domains.length);
  const normalized = normalizeCompose(compose, { routedServices });
  compose = normalized.compose;
  for (const change of normalized.changes) {
    log(`[deploy] Normalize: ${change.service}.${change.field} ${change.action}${change.before ? ` (was: ${change.before})` : ""} — ${change.reason}`);
  }

  if (app.gpuEnabled) {
    // Skip GPU reservations for services that mount a top-level named
    // volume — those are stateful infrastructure (postgres, redis, etc.)
    // and don't benefit from NVIDIA device access. A service that needs
    // GPU alongside a named volume can always declare its own reservation
    // in the source compose; injectGpuDevices preserves those.
    const statefulSkip = detectStatefulInfrastructureServices(compose);
    compose = injectGpuDevices(compose, { skip: statefulSkip });
    if (statefulSkip.size > 0) {
      log(`[deploy] GPU reservations: skipping stateful services (${[...statefulSkip].join(", ")})`);
    }
  }

  // Step 2: Detect container port
  let detectedPort: number | null = null;

  if (app.containerPort) {
    detectedPort = app.containerPort;
  } else if (ctx.builtLocally) {
    try {
      const imageName = Object.values(compose.services)[0]?.image;
      if (imageName) {
        const ports = await detectExposedPorts(imageName);
        if (ports.length > 0) {
          detectedPort = ports[0];
          log(`[deploy] Detected port from image: ${detectedPort}`);
        }
      }
    } catch { /* inspection failed, fall through */ }
  }

  if (!detectedPort && envMap.PORT) {
    detectedPort = parseInt(envMap.PORT);
  }

  if (!detectedPort && app.domains.length > 0) {
    const primaryDomain = app.domains.find((d) => d.isPrimary) ?? app.domains[0];
    if (primaryDomain.port) {
      detectedPort = primaryDomain.port;
      log(`[deploy] Using port ${detectedPort} from domain ${primaryDomain.domain}`);
    }
  }

  const containerPort = detectedPort || DEFAULT_CONTAINER_PORT;
  if (!app.containerPort) {
    log(`[deploy] Using port ${containerPort}${detectedPort ? " (auto-detected)" : " (default)"}`);
  }
  ctx.containerPort = containerPort;

  // Step 3: Inject Traefik labels + shared network
  const servicesWithCustomNetwork = Object.entries(compose.services)
    .filter(([, svc]) => svc.network_mode && svc.network_mode !== "bridge")
    .map(([name, svc]) => `${name} (${svc.network_mode})`);
  const allServicesCustomNetwork = servicesWithCustomNetwork.length === Object.keys(compose.services).length;

  if (!allServicesCustomNetwork) {
    const primaryServiceName = Object.keys(compose.services).find(
      (k) => !compose.services[k].network_mode || compose.services[k].network_mode === "bridge"
    );
    const narrowedProtocol = narrowBackendProtocol(app.backendProtocol);
    for (const domain of app.domains) {
      const port = domain.port || containerPort;
      const resolvedProtocol = resolveBackendProtocol(
        narrowedProtocol,
        port,
      );
      compose = injectTraefikLabels(compose, {
        projectName: `${app.name}-${domain.id.slice(0, 8)}`,
        appName: app.name,
        domain: domain.domain,
        containerPort: port,
        certResolver: domain.certResolver || "le",
        ssl: domain.sslEnabled ?? true,
        redirectTo: domain.redirectTo ?? undefined,
        redirectCode: domain.redirectCode ?? 301,
        serviceName: primaryServiceName,
        backendProtocol: resolvedProtocol,
      });
      if (domain.redirectTo) {
        log(`[deploy] Traefik: ${domain.domain} → redirect ${domain.redirectCode ?? 301} ${domain.redirectTo}`);
      } else {
        log(`[deploy] Traefik: ${domain.domain} → :${port}${(domain.sslEnabled ?? true) ? " (TLS)" : ""}`);
      }
    }

    // Clean up any stale file-provider config from before this change
    removeAppRouteConfig(app.name).catch(() => {});
  } else {
    log(`[deploy] Skipping Traefik labels — all services use custom network modes: ${servicesWithCustomNetwork.join(", ")}`);
  }
  // Only attach vardo-network to services that carry Traefik router labels
  // (i.e. those that need to be reachable from vardo-traefik). Databases,
  // workers, sidecars, and caches stay on the compose project's private
  // network so their per-project aliases ("postgres", "redis") can't
  // collide with identically-named services in sibling apps that also
  // share vardo-network. When no service is Traefik-routed (rare — e.g.
  // a worker-only stack with no ingress) we fall back to the historical
  // behaviour and attach everything so cross-app discovery still works.
  const traefikRouted = getTraefikRoutedServices(compose);
  if (traefikRouted.size > 0) {
    compose = injectNetwork(compose, NETWORK_NAME, { attachTo: traefikRouted });
    const skipped = Object.keys(compose.services).filter(
      (k) => !traefikRouted.has(k) && (!compose.services[k].network_mode || compose.services[k].network_mode === "bridge"),
    );
    if (skipped.length > 0) {
      log(`[deploy] vardo-network: attached to ${[...traefikRouted].join(", ")} — not attached to ${skipped.join(", ")} (private to project network)`);
    }
  } else {
    compose = injectNetwork(compose, NETWORK_NAME);
  }

  // Step 3: Add app labels
  for (const [svcName, svc] of Object.entries(compose.services)) {
    compose.services[svcName] = {
      ...svc,
      labels: {
        ...svc.labels,
        "vardo.project": app.name,
        "vardo.project.id": app.id,
        "vardo.organization": ctx.organizationId,
        "vardo.deployment.id": ctx.deploymentId,
        "vardo.environment": ctx.envName,
        "vardo.managed": "true",
      },
    };
  }

  ctx.compose = compose;
  return ctx;
}
