import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { writeFile, unlink, mkdir, rename } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import { logger } from "@/lib/logger";
import { resolveBackendProtocol, narrowBackendProtocol } from "@/lib/docker/compose";
import { TRAEFIK_DYNAMIC_DIR } from "@/lib/paths";

type TraefikRouterConfig = {
  rule: string;
  service: string;
  entryPoints: string[];
  tls?: {
    certResolver?: string;
  };
  middlewares?: string[];
  priority?: number;
};

type TraefikMiddlewareConfig = {
  redirectScheme?: {
    scheme: string;
    permanent: boolean;
  };
  redirectRegex?: {
    regex: string;
    replacement: string;
    permanent: boolean;
  };
};

type TraefikServersTransportConfig = {
  insecureSkipVerify: boolean;
};

type TraefikServiceConfig = {
  loadBalancer: {
    servers: Array<{ url: string }>;
    serversTransport?: string;
  };
};

type TraefikDynamicConfig = {
  http: {
    routers: Record<string, TraefikRouterConfig>;
    services?: Record<string, TraefikServiceConfig>;
    middlewares?: Record<string, TraefikMiddlewareConfig>;
    serversTransports?: Record<string, TraefikServersTransportConfig>;
  };
};

type AppDomainEntry = {
  id: string;
  domain: string;
  sslEnabled: boolean | null;
  certResolver: string | null;
  redirectTo: string | null;
  redirectCode: number | null;
};

/**
 * Build the Traefik HTTP router + middleware config for an app's domains.
 * Returns null when the domain list is empty.
 *
 * Used by both regenerateAppRouteConfig (writes to disk) and the debug
 * endpoint (returns as YAML without I/O).
 */
export function buildTraefikConfigYaml(
  appName: string,
  appDomains: AppDomainEntry[],
  backendProtocol?: "http" | "https" | null,
  containerName?: string | null,
  containerPort?: number | null,
): string | null {
  if (appDomains.length === 0) return null;

  const routers: Record<string, TraefikRouterConfig> = {};
  const middlewares: Record<string, TraefikMiddlewareConfig> = {};
  const serversTransports: Record<string, TraefikServersTransportConfig> = {};
  const services: Record<string, TraefikServiceConfig> = {};

  // Define the service inline so the file config is self-contained.
  // Falls back to @docker only when the container name is unknown.
  const protocol = backendProtocol === "https" ? "https" : "http";
  const port = containerPort ?? 3000;
  let serviceRef: string;

  if (containerName) {
    serviceRef = appName;
    services[appName] = {
      loadBalancer: {
        servers: [{ url: `${protocol}://${containerName}:${port}` }],
        ...(backendProtocol === "https" && { serversTransport: `${appName}-insecure` }),
      },
    };
  } else {
    serviceRef = `${appName}@docker`;
  }

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
          service: serviceRef,
          entryPoints: ["websecure"],
          tls: { certResolver },
          middlewares: [redirectMw],
          priority: 100,
        };
        routers[`${routerName}-http`] = {
          rule: `Host(\`${domain.domain}\`)`,
          service: serviceRef,
          entryPoints: ["web"],
          middlewares: [redirectMw],
          priority: 100,
        };
      } else if (ssl && isLocal) {
        routers[routerName] = {
          rule: `Host(\`${domain.domain}\`)`,
          service: serviceRef,
          entryPoints: ["websecure"],
          tls: {},
          middlewares: [redirectMw],
          priority: 100,
        };
        routers[`${routerName}-http`] = {
          rule: `Host(\`${domain.domain}\`)`,
          service: serviceRef,
          entryPoints: ["web"],
          middlewares: [redirectMw],
          priority: 100,
        };
      } else {
        routers[routerName] = {
          rule: `Host(\`${domain.domain}\`)`,
          service: serviceRef,
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
        service: serviceRef,
        entryPoints: ["websecure"],
        tls: { certResolver },
        priority: 100,
      };
      const httpRouterName = `${routerName}-http`;
      const redirectMiddleware = `${routerName}-https-redirect`;
      routers[httpRouterName] = {
        rule: `Host(\`${domain.domain}\`)`,
        service: serviceRef,
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
        service: serviceRef,
        entryPoints: ["websecure"],
        tls: {},
        priority: 100,
      };
      routers[`${routerName}-http`] = {
        rule: `Host(\`${domain.domain}\`)`,
        service: serviceRef,
        entryPoints: ["web"],
        priority: 100,
      };
    } else {
      routers[routerName] = {
        rule: `Host(\`${domain.domain}\`)`,
        service: serviceRef,
        entryPoints: ["web"],
        priority: 100,
      };
    }
  }

  if (backendProtocol === "https") {
    serversTransports[`${appName}-insecure`] = { insecureSkipVerify: true };
  }

  const config: TraefikDynamicConfig = {
    http: {
      routers,
      ...(Object.keys(services).length > 0 && { services }),
      ...(Object.keys(middlewares).length > 0 && { middlewares }),
      ...(Object.keys(serversTransports).length > 0 && { serversTransports }),
    },
  };

  return YAML.stringify(config);
}

/**
 * Regenerate the Traefik file-provider config for a given app.
 *
 * Writes one YAML file per app into the shared volume. Traefik watches the
 * directory and picks up changes within seconds — no container restart needed.
 *
 * File-provider routers use priority 100 (higher than Docker-label defaults
 * at 0) so they take precedence over stale labels from the last deploy.
 */
export async function regenerateAppRouteConfig(appId: string): Promise<void> {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
    columns: { id: true, name: true, containerPort: true, containerName: true, backendProtocol: true },
    with: { domains: true },
  });

  if (!app) {
    logger.warn(`[traefik] App ${appId} not found, skipping config generation`);
    return;
  }

  const appDomains = app.domains;

  // If no domains remain, remove the config file
  if (appDomains.length === 0) {
    await removeAppRouteConfig(app.name);
    return;
  }

  // Resolve the effective backend protocol: explicit setting wins; null auto-detects
  // from the container port (443 or 8443 → https).
  const resolvedProtocol = resolveBackendProtocol(
    narrowBackendProtocol(app.backendProtocol),
    app.containerPort ?? 3000,
  );

  const configYaml = buildTraefikConfigYaml(app.name, appDomains, resolvedProtocol, app.containerName, app.containerPort);
  if (!configYaml) {
    await removeAppRouteConfig(app.name);
    return;
  }

  try {
    await mkdir(TRAEFIK_DYNAMIC_DIR, { recursive: true });
  } catch (err: unknown) {
    // Not running in an environment with the Traefik volume — skip silently.
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "ENOENT") return;
    }
    throw err;
  }

  const filePath = join(TRAEFIK_DYNAMIC_DIR, `${app.name}.yml`);
  const tmpPath = `${filePath}.tmp`;

  try {
    await writeFile(tmpPath, configYaml, "utf-8");
    await rename(tmpPath, filePath);
  } catch (err: unknown) {
    // Not running in an environment with the Traefik volume — skip silently.
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES") return;
    }
    throw err;
  }
  logger.info(
    `[traefik] Wrote dynamic config for ${app.name} (${appDomains.length} domain(s))`
  );
}

/**
 * Remove the Traefik dynamic config file for an app.
 */
export async function removeAppRouteConfig(appName: string): Promise<void> {
  const filePath = join(TRAEFIK_DYNAMIC_DIR, `${appName}.yml`);
  try {
    await unlink(filePath);
    logger.info(`[traefik] Removed dynamic config for ${appName}`);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code !== "ENOENT") {
      throw err;
    }
    // File doesn't exist — nothing to remove
  }
}
