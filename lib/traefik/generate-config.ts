import { db } from "@/lib/db";
import { apps, domains } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import { logger } from "@/lib/logger";

/**
 * Directory where Traefik dynamic config files are written.
 * Shared volume between the frontend and traefik containers.
 */
const TRAEFIK_DYNAMIC_DIR =
  process.env.TRAEFIK_DYNAMIC_DIR || "/etc/traefik/dynamic";

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

type TraefikDynamicConfig = {
  http: {
    routers: Record<string, TraefikRouterConfig>;
    middlewares?: Record<string, TraefikMiddlewareConfig>;
  };
};

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
    columns: { id: true, name: true, containerPort: true },
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

  const routers: Record<string, TraefikRouterConfig> = {};
  const middlewares: Record<string, TraefikMiddlewareConfig> = {};

  // The service name referenced here must match the service discovered by
  // Traefik's Docker provider from the container labels. In compose.ts
  // injectTraefikLabels, the service is keyed by app.name.
  const dockerServiceRef = `${app.name}@docker`;

  for (const domain of appDomains) {
    const routerName = `${app.name}-${domain.id.slice(0, 8)}`;
    const isLocal =
      domain.domain.endsWith(".localhost") || domain.domain === "localhost";
    const ssl = domain.sslEnabled ?? true;
    const certResolver = domain.certResolver || "le";
    const isRedirect = !!domain.redirectTo;
    const permanent = (domain.redirectCode ?? 301) === 301;

    // If this is a redirect domain, create a redirectRegex middleware
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
        // HTTP router also redirects (no need for https-redirect, the domain redirect handles it)
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

    // Normal (non-redirect) domain routing
    if (ssl && !isLocal) {
      // HTTPS router
      routers[routerName] = {
        rule: `Host(\`${domain.domain}\`)`,
        service: dockerServiceRef,
        entryPoints: ["websecure"],
        tls: { certResolver },
        priority: 100,
      };

      // HTTP-to-HTTPS redirect router
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
      // Local TLS (self-signed)
      routers[routerName] = {
        rule: `Host(\`${domain.domain}\`)`,
        service: dockerServiceRef,
        entryPoints: ["websecure"],
        tls: {},
        priority: 100,
      };

      // Also listen on HTTP for local
      routers[`${routerName}-http`] = {
        rule: `Host(\`${domain.domain}\`)`,
        service: dockerServiceRef,
        entryPoints: ["web"],
        priority: 100,
      };
    } else {
      // HTTP only
      routers[routerName] = {
        rule: `Host(\`${domain.domain}\`)`,
        service: dockerServiceRef,
        entryPoints: ["web"],
        priority: 100,
      };
    }
  }

  const config: TraefikDynamicConfig = {
    http: {
      routers,
      ...(Object.keys(middlewares).length > 0 && { middlewares }),
    },
  };

  try {
    await mkdir(TRAEFIK_DYNAMIC_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const filePath = join(TRAEFIK_DYNAMIC_DIR, `${app.name}.yml`);
  await writeFile(filePath, YAML.stringify(config), "utf-8");
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
