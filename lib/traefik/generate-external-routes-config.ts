import { db } from "@/lib/db";
import { writeFile, unlink, mkdir, rename } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import { logger } from "@/lib/logger";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";

const TRAEFIK_DYNAMIC_DIR =
  process.env.TRAEFIK_DYNAMIC_DIR || "/etc/traefik/dynamic";

const EXTERNAL_ROUTES_FILE = "external-routes.yaml";

type TraefikRouterConfig = {
  rule: string;
  service: string;
  entryPoints: string[];
  tls?: {
    certResolver?: string;
  };
  middlewares?: string[];
};

type TraefikServiceConfig = {
  loadBalancer: {
    servers: { url: string }[];
    serversTransport?: string;
  };
};

type TraefikServersTransportConfig = {
  insecureSkipVerify: boolean;
};

type TraefikMiddlewareConfig = {
  redirectRegex?: {
    regex: string;
    replacement: string;
    permanent: boolean;
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

/**
 * Escape bare `$` characters in a redirect URL so they are not misinterpreted
 * as Traefik regex replacement group references. A literal `$` in a query
 * parameter (e.g. `?token=$abc`) would otherwise produce malformed replacement
 * syntax. We only escape `$` that are NOT already part of a valid `${N}` or
 * `$N` capture group reference.
 */
function sanitizeRedirectReplacement(url: string): string {
  // Replace any `$` not followed by `{` or a digit with `$$`
  return url.replace(/\$(?!\{|\d)/g, "$$$$");
}

/**
 * Regenerate the Traefik file-provider config for all external routes.
 *
 * Writes a single YAML file into the shared volume. Traefik watches the
 * directory and picks up changes within seconds — no container restart needed.
 */
export async function regenerateExternalRoutesConfig(): Promise<void> {
  const routes = await db.query.externalRoutes.findMany();

  if (routes.length === 0) {
    await removeExternalRouteConfig();
    return;
  }

  const sslConfig = await getSslConfig();
  const certResolver = getPrimaryIssuer(sslConfig);

  const routers: Record<string, TraefikRouterConfig> = {};
  const services: Record<string, TraefikServiceConfig> = {};
  const middlewares: Record<string, TraefikMiddlewareConfig> = {};
  const serversTransports: Record<string, TraefikServersTransportConfig> = {};

  for (const route of routes) {
    const safeName = `${route.hostname.replace(/[^a-zA-Z0-9-]/g, "-")}-${route.id.replace(/[^a-zA-Z0-9-]/g, "-")}`;

    // Redirect route — no upstream service needed
    if (route.redirectUrl) {
      const middlewareName = `ext-${safeName}-redirect`;
      middlewares[middlewareName] = {
        redirectRegex: {
          regex: "^https?://[^/]+(.*)$",
          replacement: `${sanitizeRedirectReplacement(route.redirectUrl)}\${1}`,
          permanent: route.redirectPermanent,
        },
      };

      if (route.tls) {
        routers[`ext-${safeName}`] = {
          rule: `Host(\`${route.hostname}\`)`,
          service: "noop@internal",
          entryPoints: ["websecure"],
          tls: { certResolver },
          middlewares: [middlewareName],
        };
        routers[`ext-${safeName}-http`] = {
          rule: `Host(\`${route.hostname}\`)`,
          service: "noop@internal",
          entryPoints: ["web"],
          middlewares: [middlewareName],
        };
      } else {
        routers[`ext-${safeName}`] = {
          rule: `Host(\`${route.hostname}\`)`,
          service: "noop@internal",
          entryPoints: ["web"],
          middlewares: [middlewareName],
        };
      }
      continue;
    }

    // Normal proxy route
    if (!route.targetUrl) continue;

    const serviceName = `ext-${safeName}`;
    const transportName = `ext-${safeName}-transport`;

    const service: TraefikServiceConfig = {
      loadBalancer: {
        servers: [{ url: route.targetUrl }],
      },
    };

    if (route.insecureSkipVerify) {
      serversTransports[transportName] = { insecureSkipVerify: true };
      service.loadBalancer.serversTransport = transportName;
    }

    services[serviceName] = service;

    if (route.tls) {
      routers[`ext-${safeName}`] = {
        rule: `Host(\`${route.hostname}\`)`,
        service: serviceName,
        entryPoints: ["websecure"],
        tls: { certResolver },
      };
      // HTTP router redirects to HTTPS
      const redirectMw = `ext-${safeName}-https-redirect`;
      middlewares[redirectMw] = {
        redirectRegex: {
          regex: "^http://(.*)$",
          replacement: "https://$1",
          permanent: true,
        },
      };
      routers[`ext-${safeName}-http`] = {
        rule: `Host(\`${route.hostname}\`)`,
        service: serviceName,
        entryPoints: ["web"],
        middlewares: [redirectMw],
      };
    } else {
      routers[`ext-${safeName}`] = {
        rule: `Host(\`${route.hostname}\`)`,
        service: serviceName,
        entryPoints: ["web"],
      };
    }
  }

  const config: TraefikDynamicConfig = {
    http: {
      routers,
      ...(Object.keys(services).length > 0 && { services }),
      ...(Object.keys(middlewares).length > 0 && { middlewares }),
      ...(Object.keys(serversTransports).length > 0 && { serversTransports }),
    },
  };

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

  const filePath = join(TRAEFIK_DYNAMIC_DIR, EXTERNAL_ROUTES_FILE);
  const tmpPath = `${filePath}.tmp`;

  try {
    await writeFile(tmpPath, YAML.stringify(config), "utf-8");
    await rename(tmpPath, filePath);
    logger.info(`[traefik] Wrote external routes config (${routes.length} route(s))`);
  } catch (err: unknown) {
    // Not running in an environment with /etc/traefik/dynamic — skip silently.
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES") return;
    }
    throw err;
  }
}

/**
 * Remove the external routes Traefik dynamic config file.
 */
export async function removeExternalRouteConfig(): Promise<void> {
  const filePath = join(TRAEFIK_DYNAMIC_DIR, EXTERNAL_ROUTES_FILE);
  try {
    await unlink(filePath);
    logger.info(`[traefik] Removed external routes config`);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // File doesn't exist — nothing to remove
  }
}
