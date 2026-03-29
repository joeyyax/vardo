import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, volumes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isAdmin } from "@/lib/auth/permissions";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import {
  generateComposeForImage,
  parseCompose,
  sanitizeCompose,
  injectResourceLimits,
  injectGpuDevices,
  stripTraefikLabels,
  injectTraefikLabels,
  injectNetwork,
  composeToYaml,
  type ComposeFile,
} from "@/lib/docker/compose";
import { listContainers, dockerRequest } from "@/lib/docker/client";
import YAML from "yaml";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const NETWORK_NAME = "vardo-network";

/**
 * Build a compose preview from the app's stored configuration.
 * Replicates the transformations applied during deploy, but without
 * cloning a repo or building images.
 */
function buildComposePreview(
  app: {
    name: string;
    deployType: string;
    source: string;
    imageName: string | null;
    composeContent: string | null;
    containerPort: number | null;
    cpuLimit: number | null;
    memoryLimit: number | null;
    gpuEnabled: boolean;
    exposedPorts: { internal: number; external?: number; protocol?: string }[] | null;
    domains: { id: string; domain: string; port: number | null; sslEnabled: boolean | null; certResolver: string | null; redirectTo: string | null; redirectCode: number | null }[];
  },
  volumesList: { name: string; mountPath: string }[],
): ComposeFile | null {
  let compose: ComposeFile | null = null;

  if (app.deployType === "image" && app.composeContent) {
    // Imported container — use stored compose
    try {
      const parsed = parseCompose(app.composeContent);
      const { compose: sanitized } = sanitizeCompose(parsed, { allowBindMounts: true });
      compose = sanitized;
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
      const { compose: sanitized } = sanitizeCompose(parsed, { allowBindMounts: true });
      compose = sanitized;
    } catch {
      return null;
    }
  } else {
    // Git repo — compose is generated during build, not available statically
    return null;
  }

  if (!compose) return null;

  // Apply resource limits
  if (app.cpuLimit || app.memoryLimit) {
    compose = injectResourceLimits(compose, {
      cpuLimit: app.cpuLimit,
      memoryLimit: app.memoryLimit,
    });
  }

  // Apply GPU devices
  if (app.gpuEnabled) {
    compose = injectGpuDevices(compose);
  }

  // Apply Traefik labels (same logic as deploy.ts)
  const servicesWithCustomNetwork = Object.entries(compose.services)
    .filter(([, svc]) => svc.network_mode && svc.network_mode !== "bridge")
    .map(([name]) => name);
  const allServicesCustomNetwork =
    servicesWithCustomNetwork.length === Object.keys(compose.services).length;

  if (!allServicesCustomNetwork) {
    compose = stripTraefikLabels(compose);

    const primaryServiceName = Object.keys(compose.services).find(
      (k) => !compose!.services[k].network_mode || compose!.services[k].network_mode === "bridge",
    );

    for (const domain of app.domains) {
      const port = domain.port || app.containerPort || 3000;
      compose = injectTraefikLabels(compose, {
        projectName: `${app.name}-${domain.id.slice(0, 6)}`,
        appName: app.name,
        domain: domain.domain,
        containerPort: port,
        certResolver: domain.certResolver || "le",
        ssl: domain.sslEnabled ?? true,
        redirectTo: domain.redirectTo ?? undefined,
        redirectCode: domain.redirectCode ?? 301,
        serviceName: primaryServiceName,
      });
    }
  }

  // Inject shared network
  compose = injectNetwork(compose, NETWORK_NAME);

  return compose;
}

/**
 * Generate the Traefik file-provider config YAML for an app without writing it to disk.
 */
function buildTraefikConfigYaml(
  appName: string,
  appDomains: {
    id: string;
    domain: string;
    sslEnabled: boolean | null;
    certResolver: string | null;
    redirectTo: string | null;
    redirectCode: number | null;
  }[],
): string | null {
  if (appDomains.length === 0) return null;

  const routers: Record<string, unknown> = {};
  const middlewares: Record<string, unknown> = {};
  const dockerServiceRef = `${appName}@docker`;

  for (const domain of appDomains) {
    const routerName = `${appName}-${domain.id.slice(0, 8)}`;
    const isLocal =
      domain.domain.endsWith(".localhost") || domain.domain === "localhost";
    const ssl = domain.sslEnabled ?? true;
    const certResolver = domain.certResolver || "le";
    const isRedirect = !!domain.redirectTo;
    const permanent = (domain.redirectCode ?? 301) === 301;

    if (isRedirect) {
      const redirectMw = `${routerName}-redirect`;
      middlewares[redirectMw] = {
        redirectRegex: {
          regex: "^https?://[^/]+(.*)$",
          replacement: `${domain.redirectTo}\${1}`,
          permanent,
        },
      };

      if (ssl && !isLocal) {
        routers[routerName] = {
          rule: `Host(\`${domain.domain}\`)`,
          service: dockerServiceRef,
          entryPoints: ["websecure"],
          tls: { certResolver },
          middlewares: [redirectMw],
          priority: 100,
        };
        routers[`${routerName}-http`] = {
          rule: `Host(\`${domain.domain}\`)`,
          service: dockerServiceRef,
          entryPoints: ["web"],
          middlewares: [redirectMw],
          priority: 100,
        };
      } else if (ssl && isLocal) {
        routers[routerName] = {
          rule: `Host(\`${domain.domain}\`)`,
          service: dockerServiceRef,
          entryPoints: ["websecure"],
          tls: {},
          middlewares: [redirectMw],
          priority: 100,
        };
        routers[`${routerName}-http`] = {
          rule: `Host(\`${domain.domain}\`)`,
          service: dockerServiceRef,
          entryPoints: ["web"],
          middlewares: [redirectMw],
          priority: 100,
        };
      } else {
        routers[routerName] = {
          rule: `Host(\`${domain.domain}\`)`,
          service: dockerServiceRef,
          entryPoints: ["web"],
          middlewares: [redirectMw],
          priority: 100,
        };
      }
      continue;
    }

    if (ssl && !isLocal) {
      routers[routerName] = {
        rule: `Host(\`${domain.domain}\`)`,
        service: dockerServiceRef,
        entryPoints: ["websecure"],
        tls: { certResolver },
        priority: 100,
      };
      const httpRouterName = `${routerName}-http`;
      const redirectMiddleware = `${routerName}-https-redirect`;
      routers[httpRouterName] = {
        rule: `Host(\`${domain.domain}\`)`,
        service: dockerServiceRef,
        entryPoints: ["web"],
        middlewares: [redirectMiddleware],
        priority: 100,
      };
      middlewares[redirectMiddleware] = {
        redirectScheme: {
          scheme: "https",
          permanent: true,
        },
      };
    } else if (ssl && isLocal) {
      routers[routerName] = {
        rule: `Host(\`${domain.domain}\`)`,
        service: dockerServiceRef,
        entryPoints: ["websecure"],
        tls: {},
        priority: 100,
      };
      routers[`${routerName}-http`] = {
        rule: `Host(\`${domain.domain}\`)`,
        service: dockerServiceRef,
        entryPoints: ["web"],
        priority: 100,
      };
    } else {
      routers[routerName] = {
        rule: `Host(\`${domain.domain}\`)`,
        service: dockerServiceRef,
        entryPoints: ["web"],
        priority: 100,
      };
    }
  }

  const config = {
    http: {
      routers,
      ...(Object.keys(middlewares).length > 0 && { middlewares }),
    },
  };

  return YAML.stringify(config);
}

// GET /api/v1/organizations/[orgId]/apps/[appId]/debug
async function handler(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (!isAdmin(org.membership.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      with: { domains: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const appVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, appId),
    });
    const volumesList = appVolumes
      .filter((v) => v.persistent)
      .map((v) => ({ name: v.name, mountPath: v.mountPath }));

    // Generate compose preview
    const composeParsed = buildComposePreview(
      {
        name: app.name,
        deployType: app.deployType,
        source: app.source,
        imageName: app.imageName,
        composeContent: app.composeContent,
        containerPort: app.containerPort,
        cpuLimit: app.cpuLimit ?? null,
        memoryLimit: app.memoryLimit ?? null,
        gpuEnabled: app.gpuEnabled,
        exposedPorts: app.exposedPorts as { internal: number; external?: number; protocol?: string }[] | null,
        domains: app.domains.map((d) => ({
          id: d.id,
          domain: d.domain,
          port: d.port ?? null,
          sslEnabled: d.sslEnabled ?? null,
          certResolver: d.certResolver ?? null,
          redirectTo: d.redirectTo ?? null,
          redirectCode: d.redirectCode ?? null,
        })),
      },
      volumesList,
    );

    const compose = composeParsed ? composeToYaml(composeParsed) : null;

    // Generate Traefik config
    const traefikConfig = buildTraefikConfigYaml(
      app.name,
      app.domains.map((d) => ({
        id: d.id,
        domain: d.domain,
        sslEnabled: d.sslEnabled ?? null,
        certResolver: d.certResolver ?? null,
        redirectTo: d.redirectTo ?? null,
        redirectCode: d.redirectCode ?? null,
      })),
    );

    // Get container inspect data
    let containers: unknown[] = [];
    try {
      const containerList = await listContainers(app.name);
      const inspectResults = await Promise.allSettled(
        containerList.map((c) =>
          dockerRequest("GET", `/containers/${encodeURIComponent(c.id)}/json`),
        ),
      );
      containers = inspectResults
        .filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled")
        .map((r) => {
          const c = r.value as Record<string, unknown>;
          // Strip Env — env vars are encrypted at rest and must not be exposed via this endpoint
          if (c.Config && typeof c.Config === "object") {
            const config = { ...(c.Config as Record<string, unknown>) };
            delete config.Env;
            return { ...c, Config: config };
          }
          return c;
        });
    } catch {
      // Docker not available — return empty
    }

    return NextResponse.json({ compose, traefikConfig, containers });
  } catch (error) {
    return handleRouteError(error, "Error loading debug info");
  }
}

export const GET = withRateLimit(handler, { tier: "admin", key: "app-debug" });
