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
  getServicesWithExternalizedVolumes,
  stripVardoInjections,
  getTraefikRoutedServices,
} from "../compose";
import { detectExposedPorts } from "../client";
import { normalizeCompose } from "../compose-normalize";
import { removeAppRouteConfig } from "@/lib/ssl/generate-config";
import {
  NETWORK_NAME as VARDO_NETWORK,
  DEFAULT_CONTAINER_PORT,
} from "../constants";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import type { DeployContext } from "../deploy-context";
import type { ServiceConfigOverride } from "../compose-types";

const NETWORK_NAME = VARDO_NETWORK;

export async function resolveCompose(ctx: DeployContext): Promise<DeployContext> {
  const { app, log, envMap } = ctx;
  let compose = ctx.compose;

  // Capture the bare compose before any Vardo injections. Strip any
  // existing Traefik/vardo labels that came in via import.
  const bareCompose = stripVardoInjections(compose, NETWORK_NAME);
  ctx.bareCompose = bareCompose;

  // Normalize: treat the user's compose as intent, produce safe runtime config.
  // Host ports are intentionally KEPT. Vardo writes the user's bare compose to
  // disk (`ctx.bareCompose`) and layers Traefik routing on top via an override —
  // and a Compose override can't un-publish a port, so stripping here never
  // reached the running container; it only produced a misleading "host port
  // removed" line in the deploy log. Slot cutover already tears down the old
  // slot before starting the new one, so a kept host port never collides
  // between blue/green.
  const normalized = normalizeCompose(compose, { keepHostPorts: true });
  compose = normalized.compose;
  for (const change of normalized.changes) {
    log(`[deploy] Normalize: ${change.service}.${change.field} ${change.action}${change.before ? ` (was: ${change.before})` : ""} — ${change.reason}`);
  }

  // Per-service config from decomposed child app rows. A decomposed compose
  // app has a child app per service (parentAppId + composeService); the child
  // carries its own resources/GPU that the deploy must honor — otherwise
  // toggling e.g. GPU on a child is a silent no-op (#745). Empty for
  // non-decomposed apps, which keep using the parent's global values.
  const children = await db.query.apps.findMany({
    where: and(
      eq(apps.parentAppId, app.id),
      eq(apps.organizationId, ctx.organizationId),
    ),
    columns: { composeService: true, cpuLimit: true, memoryLimit: true, gpuEnabled: true },
  });
  const childByService = new Map(
    children.filter((c) => c.composeService).map((c) => [c.composeService!, c]),
  );
  const serviceConfig: Record<string, ServiceConfigOverride> = {};
  for (const name of Object.keys(compose.services)) {
    const child = childByService.get(name);
    if (!child) continue;
    serviceConfig[name] = {
      // Child value wins; fall back to the parent global when the child has none.
      cpuLimit: child.cpuLimit ?? app.cpuLimit,
      memoryLimit: child.memoryLimit ?? app.memoryLimit,
      // GPU is opt-in either level: parent-wide flag OR the child's own toggle.
      gpuEnabled: !!app.gpuEnabled || child.gpuEnabled,
    };
  }
  ctx.serviceConfig = serviceConfig;

  if (app.gpuEnabled) {
    // Skip GPU reservations for services that mount a top-level named
    // volume — those are stateful infrastructure (postgres, redis, etc.)
    // and don't benefit from NVIDIA device access. A service that needs
    // GPU alongside a named volume can always declare its own reservation
    // in the source compose; injectGpuDevices preserves those.
    const statefulSkip = getServicesWithExternalizedVolumes(compose);
    compose = injectGpuDevices(compose, { skip: statefulSkip });
    if (statefulSkip.size > 0) {
      log(`[deploy] GPU reservations: skipping stateful services (${[...statefulSkip].join(", ")})`);
    }
  }

  // Per-child GPU toggles: attach the device to exactly those services, even
  // stateful ones — the user opted in on that specific service (#745).
  const childGpuServices = new Set(
    children.filter((c) => c.gpuEnabled && c.composeService).map((c) => c.composeService!),
  );
  if (childGpuServices.size > 0) {
    compose = injectGpuDevices(compose, { include: childGpuServices });
    log(`[deploy] GPU reservations: child services (${[...childGpuServices].join(", ")})`);
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
        certResolver: domain.certResolver || "le-dns",
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
  // share vardo-network.
  //
  // When no service is Traefik-routed — e.g. a worker-only stack with no
  // ingress — we attach NOTHING to vardo-network. The previous behaviour
  // ("attach everywhere") was the exact condition that caused the
  // production outage: every sibling app's postgres/redis ended up on
  // vardo-network with the same DNS alias. Cross-project DNS discovery
  // through vardo-network is not a supported pattern; apps that genuinely
  // need it should route through vardo-traefik via a Host() label.
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
    log(`[deploy] vardo-network: no Traefik-routed service — skipping injection (app stays on its project-private network)`);
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
