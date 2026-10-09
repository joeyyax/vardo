// Deploy steps 2-3: port detection plus Traefik, network, GPU and app-label injection.

import {
  injectTraefikLabels,
  domainRouteOptions,
  injectNetwork,
  resolveBackendProtocol,
  narrowBackendProtocol,
  injectGpuDevices,
  getServicesWithExternalizedVolumes,
  stripVardoInjections,
  stripTraefikLabels,
  getTraefikRoutedServices,
} from "../compose";
import { selectRoutedService } from "../routed-service";
import { formatRoute } from "@/lib/domains/path-prefix";
import { partitionMiddlewares } from "@/lib/domains/middlewares";
import { detectExposedPorts } from "../client";
import type { ComposeFile } from "../compose-types";
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
import { appScope } from "@/lib/infra/instance-apps";
import { handWrittenRoute, isolateCompose } from "../environment-isolation";
import { nonRotatingServices } from "../slot-partition";
import { assertLabelHostsOwned } from "../label-hosts";

const NETWORK_NAME = VARDO_NETWORK;

/** Ports each service's image exposes. Best-effort; unpulled images contribute nothing. */
async function imagePortsByService(
  compose: ComposeFile,
): Promise<Record<string, number[]>> {
  const entries = Object.entries(compose.services).filter(([, svc]) => svc.image);
  if (entries.length < 2) return {};

  const result: Record<string, number[]> = {};
  await Promise.all(
    entries.map(async ([name, svc]) => {
      try {
        const ports = await detectExposedPorts(svc.image!);
        if (ports.length > 0) result[name] = ports;
      } catch {
        // Image not local.
      }
    }),
  );
  return result;
}

export async function resolveCompose(ctx: DeployContext): Promise<DeployContext> {
  const { app, log, envMap } = ctx;
  let compose = ctx.compose;

  // Bare compose before Vardo injections, minus imported Traefik/vardo labels.
  const bareCompose = stripVardoInjections(compose, NETWORK_NAME);
  ctx.bareCompose = bareCompose;

  // Repo routing labels belong to production; route the environment's hostname to their target instead.
  if (ctx.envIsolated) {
    const route = handWrittenRoute(compose);
    if (route) {
      for (const domain of app.domains) {
        domain.serviceName ??= route.service;
        domain.port ??= route.port;
      }
    }
    compose = isolateCompose(compose);
    ctx.bareCompose = isolateCompose(ctx.bareCompose);
    log(`[deploy] ${ctx.envName}: production routing labels removed`);
  }

  // Host ports are kept: a Compose override can't un-publish them, and cutover stops the old slot first.
  const normalized = normalizeCompose(compose, {
    keepHostPorts: true,
    restartPolicy: app.restartPolicy,
  });
  compose = normalized.compose;
  for (const change of normalized.changes) {
    log(`[deploy] Normalize: ${change.service}.${change.field} ${change.action}${change.before ? ` (was: ${change.before})` : ""} — ${change.reason}`);
  }

  // Per-service resources and GPU from decomposed child apps (#745).
  const children = await db.query.apps.findMany({
    where: and(
      eq(apps.parentAppId, app.id),
      eq(apps.organizationId, ctx.organizationId),
    ),
    columns: { composeService: true, cpuLimit: true, memoryLimit: true, gpuEnabled: true, priority: true },
  });
  const childByService = new Map(
    children.filter((c) => c.composeService).map((c) => [c.composeService!, c]),
  );
  const serviceConfig: Record<string, ServiceConfigOverride> = {};
  for (const name of Object.keys(compose.services)) {
    const child = childByService.get(name);
    if (!child) continue;
    serviceConfig[name] = {
      cpuLimit: child.cpuLimit ?? app.cpuLimit,
      memoryLimit: child.memoryLimit ?? app.memoryLimit,
      // GPU is on if the parent or the child enables it.
      gpuEnabled: !!app.gpuEnabled || child.gpuEnabled,
      priority: child.priority ?? app.priority,
    };
  }
  ctx.serviceConfig = serviceConfig;

  if (app.gpuEnabled) {
    // Skip services with a top-level named volume (stateful infrastructure).
    const statefulSkip = getServicesWithExternalizedVolumes(compose);
    compose = injectGpuDevices(compose, { skip: statefulSkip });
    if (statefulSkip.size > 0) {
      log(`[deploy] GPU reservations: skipping stateful services (${[...statefulSkip].join(", ")})`);
    }
  }

  // Per-child GPU toggles apply even to stateful services (#745).
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

  if (!allServicesCustomNetwork && app.domains.length > 0) {
    // Vardo owns routing once the app has a domain; inbound labels would add a second backend.
    compose = stripTraefikLabels(compose);

    // Inspect images only when compose doesn't say which service serves the port.
    const needsImagePorts = app.domains.some(
      (d) =>
        !["override", "sole-candidate", "declared-port"].includes(
          selectRoutedService(compose, {
            containerPort: d.port || containerPort,
            override: d.serviceName,
          }).reason,
        ),
    );
    const imagePorts = needsImagePorts ? await imagePortsByService(compose) : {};
    const narrowedProtocol = narrowBackendProtocol(app.backendProtocol);
    // Production names must stay byte-identical; live routers carry them.
    const envRoute = ctx.envIsolated ? `${app.name}-${ctx.envName}` : undefined;
    for (const domain of app.domains) {
      const port = domain.port || containerPort;
      const resolvedProtocol = resolveBackendProtocol(
        narrowedProtocol,
        port,
      );
      // A child app's domain routes to its compose service; otherwise pick the one serving the port.
      const selection = selectRoutedService(compose, {
        containerPort: port,
        override: domain.serviceName,
        imagePorts,
      });
      const targetService = selection.service;
      if (selection.ambiguous) {
        log(
          `[deploy] Traefik: nothing identifies which service serves :${port} — routing ${domain.domain} to ${targetService} (candidates: ${selection.ambiguous.join(", ")}). Set the domain's compose service to pin it.`,
        );
      }
      const refused = partitionMiddlewares(domain.middlewares, ctx.orgTrusted).refused;
      if (refused.length > 0) {
        log(`[deploy] Traefik: ${domain.domain} skips middlewares this organization can't use: ${refused.join(", ")}`);
      }
      compose = injectTraefikLabels(compose, {
        ...domainRouteOptions(domain, { trusted: ctx.orgTrusted }),
        projectName: envRoute ?? `${app.name}-${domain.id.slice(0, 8)}`,
        appName: app.name,
        traefikService: envRoute,
        containerPort: port,
        serviceName: targetService,
        backendProtocol: resolvedProtocol,
      });
      const svcSuffix = targetService ? ` → ${targetService}` : "";
      const route = formatRoute(domain.domain, domain.pathPrefix);
      if (domain.redirectTo) {
        log(`[deploy] Traefik: ${route} → redirect ${domain.redirectCode ?? 301} ${domain.redirectTo}${svcSuffix}`);
      } else {
        log(`[deploy] Traefik: ${route} → :${port}${(domain.sslEnabled ?? true) ? " (TLS)" : ""}${svcSuffix}`);
      }
    }

    // Remove stale file-provider config.
    if (!ctx.envIsolated) removeAppRouteConfig(app.name).catch(() => {});
  } else if (allServicesCustomNetwork) {
    log(`[deploy] Skipping Traefik labels — all services use custom network modes: ${servicesWithCustomNetwork.join(", ")}`);
  }
  await assertLabelHostsOwned(ctx, compose);

  // Only Traefik-routed services join vardo-network, never all of them.
  // Shared aliases like "postgres" would collide across sibling apps.
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

  // Step 3: app labels. vardo.scope keeps instance infrastructure logs out of org tenants.
  const scope = appScope(app.name);
  // No deployment-id label on shared services; it would change their config hash every deploy.
  const shared = nonRotatingServices(compose);

  for (const [svcName, svc] of Object.entries(compose.services)) {
    compose.services[svcName] = {
      ...svc,
      labels: {
        ...svc.labels,
        "vardo.project": app.name,
        "vardo.project.id": app.id,
        "vardo.organization": ctx.organizationId,
        ...(shared.has(svcName) ? {} : { "vardo.deployment.id": ctx.deploymentId }),
        "vardo.environment": ctx.envName,
        "vardo.managed": "true",
        "vardo.scope": scope,
      },
    };
  }

  ctx.compose = compose;
  return ctx;
}
