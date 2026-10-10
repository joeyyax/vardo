import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  TRAEFIK_MANUAL_LABEL,
  applyDeployTransforms,
  domainRouteOptions,
  buildVardoOverlay,
  injectNetwork,
  injectTraefikLabels,
  isTraefikSelfRouted,
  SECURITY_HEADERS,
  stripTraefikLabels,
  stripVardoInjections,
} from "@/lib/docker/compose-inject";
import { parseCompose } from "@/lib/docker/compose-parse";
import { sharedNetworks } from "@/lib/docker/shared-networks";
import { selectRoutedService } from "@/lib/docker/routed-service";
import type { ComposeFile, DeployTransformDomain } from "@/lib/docker/compose-types";

const NETWORK = "vardo-network";

/** A service declaring its own routers, plus a plain sibling. */
function selfRoutedCompose(): ComposeFile {
  return {
    services: {
      web: {
        name: "web",
        image: "app:latest",
        labels: {
          [TRAEFIK_MANUAL_LABEL]: "manual",
          "traefik.enable": "true",
          "traefik.http.routers.web.rule": "Host(`app.test`)",
          "traefik.http.routers.web-fallback.rule": "PathPrefix(`/`)",
          "traefik.http.routers.web-fallback.priority": "1",
          "traefik.http.services.web.loadbalancer.server.port": "3000",
          "com.example.owner": "ops",
        },
        networks: [NETWORK],
      },
      worker: {
        name: "worker",
        image: "app:latest",
        labels: { "traefik.enable": "true", "traefik.http.routers.worker.rule": "Host(`w.test`)" },
      },
    },
  };
}

const domain = {
  id: "abcdef123456",
  domain: "app.test",
  port: 3000,
  sslEnabled: true,
  isPrimary: true,
  certResolver: null,
  redirectTo: null,
  redirectCode: null,
  serviceName: null,
};

describe("isTraefikSelfRouted", () => {
  it("reads the marker label", () => {
    expect(isTraefikSelfRouted(selfRoutedCompose().services.web)).toBe(true);
  });

  it("is false for a service without it", () => {
    expect(isTraefikSelfRouted(selfRoutedCompose().services.worker)).toBe(false);
  });

  it("is false for a different marker value", () => {
    const svc = { name: "web", labels: { [TRAEFIK_MANUAL_LABEL]: "auto" } };
    expect(isTraefikSelfRouted(svc)).toBe(false);
  });
});

describe("stripTraefikLabels — self-routed services", () => {
  it("leaves a self-routed service whole", () => {
    const before = selfRoutedCompose().services.web.labels;
    expect(stripTraefikLabels(selfRoutedCompose()).services.web.labels).toEqual(before);
  });

  it("still strips services without the marker", () => {
    expect(stripTraefikLabels(selfRoutedCompose()).services.worker.labels).toEqual({});
  });
});

describe("stripVardoInjections — self-routed services", () => {
  it("keeps the Traefik block and the marker", () => {
    const result = stripVardoInjections(selfRoutedCompose(), NETWORK);
    expect(result.services.web.labels).toEqual(selfRoutedCompose().services.web.labels);
  });

  it("still removes vardo metadata labels and the shared network", () => {
    const compose = selfRoutedCompose();
    compose.services.web.labels!["vardo.project"] = "demo";
    compose.services.web.labels!["vardo.managed"] = "true";
    const result = stripVardoInjections(compose, NETWORK);
    expect(result.services.web.labels).not.toHaveProperty("vardo.project");
    expect(result.services.web.labels).not.toHaveProperty("vardo.managed");
    expect(result.services.web.labels).toHaveProperty(TRAEFIK_MANUAL_LABEL);
    expect(result.services.web.networks).toBeUndefined();
  });

  it("still strips Traefik labels from services without the marker", () => {
    const result = stripVardoInjections(selfRoutedCompose(), NETWORK);
    expect(result.services.worker.labels).toBeUndefined();
  });
});

describe("injectTraefikLabels — self-routed services", () => {
  it("generates nothing when the target routes itself", () => {
    const compose = selfRoutedCompose();
    const result = injectTraefikLabels(compose, {
      projectName: "demo-abcdef",
      appName: "demo",
      domain: "app.test",
      containerPort: 3000,
      serviceName: "web",
    });
    expect(result).toBe(compose);
  });

  it("does not prune a self-routed sibling when routing another service", () => {
    const result = injectTraefikLabels(selfRoutedCompose(), {
      projectName: "web-abcdef",
      appName: "web",
      domain: "w.test",
      containerPort: 3000,
      serviceName: "worker",
    });
    expect(result.services.web.labels).toEqual(selfRoutedCompose().services.web.labels);
    expect(result.services.worker.labels).toHaveProperty(
      "traefik.http.routers.web-abcdef.rule",
    );
  });
});

describe("buildVardoOverlay — self-routed services", () => {
  it("leaves the Traefik block out of the overlay", () => {
    const compose = selfRoutedCompose();
    compose.services.web.labels!["vardo.project"] = "demo";
    const overlay = buildVardoOverlay({ fullCompose: compose, networkName: NETWORK });
    expect(overlay.services.web.labels).toEqual({ "vardo.project": "demo" });
    expect(overlay.services.web.networks).toEqual([NETWORK]);
  });

  it("still copies Traefik labels for services without the marker", () => {
    const overlay = buildVardoOverlay({
      fullCompose: selfRoutedCompose(),
      networkName: NETWORK,
    });
    expect(overlay.services.worker.labels).toHaveProperty("traefik.http.routers.worker.rule");
  });
});

describe("buildVardoOverlay — restart policy", () => {
  it("carries the resolved restart policy into the overlay", () => {
    const compose = selfRoutedCompose();
    compose.services.web.restart = "unless-stopped";
    compose.services.worker.restart = "on-failure";

    const overlay = buildVardoOverlay({ fullCompose: compose, networkName: NETWORK });

    expect(overlay.services.web.restart).toBe("unless-stopped");
    expect(overlay.services.worker.restart).toBe("on-failure");
  });

  it("omits restart when the compose carries none", () => {
    const overlay = buildVardoOverlay({
      fullCompose: selfRoutedCompose(),
      networkName: NETWORK,
    });
    expect(overlay.services.web.restart).toBeUndefined();
  });
});

describe("applyDeployTransforms — a self-routed app with a domain", () => {
  it("keeps the declared routers and adds none", () => {
    const result = applyDeployTransforms(selfRoutedCompose(), {
      appName: "web",
      containerPort: 3000,
      domains: [domain],
      networkName: NETWORK,
    });
    expect(result.services.web.labels).toMatchObject(selfRoutedCompose().services.web.labels!);
    const routers = Object.keys(result.services.web.labels ?? {}).filter((k) =>
      k.startsWith("traefik.http.routers."),
    );
    expect(routers.every((k) => k.startsWith("traefik.http.routers.web"))).toBe(true);
  });

  it("still attaches the self-routed service to the shared network", () => {
    const result = applyDeployTransforms(selfRoutedCompose(), {
      appName: "web",
      containerPort: 3000,
      domains: [domain],
      networkName: NETWORK,
    });
    expect(result.services.web.networks).toContain(NETWORK);
  });
});

// ---------------------------------------------------------------------------
// Ordinary apps — the marker changes nothing for them
// ---------------------------------------------------------------------------

describe("unmarked apps keep the existing behavior", () => {
  function importedCompose(): ComposeFile {
    return {
      services: {
        web: {
          name: "web",
          image: "app:latest",
          labels: {
            "traefik.enable": "true",
            "traefik.http.routers.web.rule": "Host(`old.test`)",
            "traefik.http.services.web.loadbalancer.server.port": "8080",
          },
        },
      },
    };
  }

  it("replaces imported routers with the generated one", () => {
    const result = applyDeployTransforms(importedCompose(), {
      appName: "web",
      containerPort: 3000,
      domains: [domain],
      networkName: NETWORK,
    });
    const labels = result.services.web.labels ?? {};
    expect(labels).not.toHaveProperty("traefik.http.routers.web.rule");
    expect(labels["traefik.http.routers.web-abcdef.rule"]).toBe("Host(`app.test`)");
  });

  it("strips Traefik labels from the bare compose", () => {
    const result = stripVardoInjections(importedCompose(), NETWORK);
    expect(result.services.web.labels).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Vardo's own stack
// ---------------------------------------------------------------------------

describe("Vardo's own compose survives the deploy transforms", () => {
  const yaml = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf-8");

  /** The repo compose with the frontend claiming its labels. */
  function vardoCompose(): ComposeFile {
    const compose = parseCompose(yaml);
    compose.services.frontend.labels = {
      [TRAEFIK_MANUAL_LABEL]: "manual",
      ...compose.services.frontend.labels,
    };
    return compose;
  }

  function routerKeys(labels: Record<string, string> | undefined): string[] {
    return Object.keys(labels ?? {}).filter((k) => k.startsWith("traefik.http."));
  }

  it("routes the frontend, so a generated router would land there", () => {
    expect(selectRoutedService(parseCompose(yaml), { containerPort: 3000 }).service).toBe(
      "frontend",
    );
  });

  it("keeps every router and middleware in the on-disk compose pair", () => {
    const compose = vardoCompose();
    const declared = routerKeys(compose.services.frontend.labels);
    expect(declared.length).toBeGreaterThan(20);

    const bare = stripVardoInjections(compose, NETWORK);
    const overlay = buildVardoOverlay({ fullCompose: compose, networkName: NETWORK });
    const merged = {
      ...bare.services.frontend.labels,
      ...overlay.services.frontend.labels,
    };
    for (const key of declared) {
      expect(merged[key]).toBe(compose.services.frontend.labels![key]);
    }
    expect(merged["traefik.enable"]).toBe("true");
  });

  it("keeps them even once a domain is registered for the app", () => {
    const result = applyDeployTransforms(vardoCompose(), {
      appName: "vardo",
      containerPort: 3000,
      domains: [{ ...domain, domain: "vardo.test" }],
      networkName: NETWORK,
    });
    const labels = result.services.frontend.labels ?? {};
    for (const key of routerKeys(vardoCompose().services.frontend.labels)) {
      expect(labels[key]).toBe(vardoCompose().services.frontend.labels![key]);
    }
    expect(labels).not.toHaveProperty("traefik.http.routers.vardo-abcdef.rule");
  });
});

describe("injectTraefikLabels domain validation", () => {
  const compose: ComposeFile = { services: { web: { name: "web", image: "nginx" } } };
  const opts = { projectName: "demo-abcdef", appName: "demo", containerPort: 3000, serviceName: "web" };

  it("refuses a domain that would rewrite the Host rule", () => {
    expect(() =>
      injectTraefikLabels(compose, { ...opts, domain: "mine.test`) || Host(`victim.test" }),
    ).toThrow(/invalid domain/);
  });

  it("routes a plain hostname", () => {
    const result = injectTraefikLabels(compose, { ...opts, domain: "app.example.com" });
    expect(result.services.web.labels?.["traefik.http.routers.demo-abcdef.rule"]).toBe("Host(`app.example.com`)");
  });
});

describe("injectTraefikLabels path prefix", () => {
  const base = (): ComposeFile => ({ services: { web: { name: "web", image: "app:latest" } } });
  const inject = (opts: { pathPrefix?: string | null; stripPathPrefix?: boolean; redirectTo?: string; ssl?: boolean }) =>
    injectTraefikLabels(base(), { projectName: "docs-abc", appName: "docs", domain: "acme.test", containerPort: 80, ...opts })
      .services.web.labels!;

  it("matches the host and path on both routers, ranked above the host's root route", () => {
    const labels = inject({ pathPrefix: "/docs" });
    expect(labels["traefik.http.routers.docs-abc.rule"]).toBe("Host(`acme.test`) && (Path(`/docs`) || PathPrefix(`/docs/`))");
    expect(labels["traefik.http.routers.docs-abc-http.rule"]).toBe("Host(`acme.test`) && (Path(`/docs`) || PathPrefix(`/docs/`))");
    expect(labels["traefik.http.routers.docs-abc.priority"]).toBe("1005");
    expect(labels["traefik.http.routers.docs-abc-http.priority"]).toBe("1005");
    expect(labels["traefik.http.routers.docs-abc.middlewares"]).toBeUndefined();
  });

  it("strips the prefix when asked", () => {
    const labels = inject({ pathPrefix: "/docs", stripPathPrefix: true });
    expect(labels["traefik.http.middlewares.docs-abc-strip.stripprefix.prefixes"]).toBe("/docs");
    expect(labels["traefik.http.routers.docs-abc.middlewares"]).toBe("docs-abc-strip");
    expect(labels["traefik.http.routers.docs-abc-http.middlewares"]).toBe("docs-abc-https-redirect");
  });

  it("strips on the plain-HTTP router when TLS is off", () => {
    const labels = inject({ pathPrefix: "/docs", stripPathPrefix: true, ssl: false });
    expect(labels["traefik.http.routers.docs-abc.entrypoints"]).toBe("web");
    expect(labels["traefik.http.routers.docs-abc.middlewares"]).toBe("docs-abc-strip");
  });

  it("keeps the path on a redirect and skips the strip", () => {
    const labels = inject({ pathPrefix: "/old", stripPathPrefix: true, redirectTo: "https://new.test" });
    expect(labels["traefik.http.routers.docs-abc.middlewares"]).toBe("docs-abc-redirect");
    expect(labels["traefik.http.middlewares.docs-abc-strip.stripprefix.prefixes"]).toBeUndefined();
  });

  it("writes no priority or path matcher without a prefix", () => {
    const labels = inject({ pathPrefix: null });
    expect(labels["traefik.http.routers.docs-abc.rule"]).toBe("Host(`acme.test`)");
    expect(labels["traefik.http.routers.docs-abc.priority"]).toBeUndefined();
  });

  it("refuses a prefix that would rewrite the rule", () => {
    expect(() => inject({ pathPrefix: "/a`) || Host(`evil.test" })).toThrow(/invalid path/);
  });
});

describe("injectTraefikLabels domain middlewares", () => {
  const base = (): ComposeFile => ({ services: { web: { name: "web", image: "app:latest" } } });
  const row: DeployTransformDomain = {
    id: "abcdef123456",
    domain: "search.test",
    port: 80,
    sslEnabled: true,
    certResolver: "le-dns",
    redirectTo: null,
    redirectCode: null,
    middlewares: "cloudflare-only@file,auth@docker",
  };
  const inject = (domain: DeployTransformDomain, trusted: boolean) =>
    injectTraefikLabels(base(), {
      ...domainRouteOptions(domain, { trusted }),
      projectName: "search-abc",
      appName: "search",
      containerPort: 80,
    }).services.web.labels!;

  it("puts the domain's middlewares on the router that serves the app, not the HTTPS redirect", () => {
    const labels = inject(row, true);
    expect(labels["traefik.http.routers.search-abc.middlewares"]).toBe("cloudflare-only@file,auth@docker");
    expect(labels["traefik.http.routers.search-abc-http.middlewares"]).toBe("search-abc-https-redirect");
  });

  it("drops middlewares an untrusted organization can't use", () => {
    expect(inject(row, false)["traefik.http.routers.search-abc.middlewares"]).toBe("cloudflare-only@file");
  });

  it("runs the lock before the strip and the redirect", () => {
    const strip = inject({ ...row, middlewares: "cloudflare-only@file", pathPrefix: "/docs", stripPathPrefix: true }, false);
    expect(strip["traefik.http.routers.search-abc.middlewares"]).toBe("cloudflare-only@file,search-abc-strip");
    const redirect = inject({ ...row, middlewares: "cloudflare-only@file", redirectTo: "https://new.test" }, false);
    expect(redirect["traefik.http.routers.search-abc.middlewares"]).toBe("cloudflare-only@file,search-abc-redirect");
  });

  it("refuses a malformed reference even when trusted", () => {
    expect(() =>
      injectTraefikLabels(base(), { projectName: "p", domain: "a.test", containerPort: 80, middlewares: ["a`b"] }),
    ).toThrow(/invalid middleware/);
  });
});

describe("injectTraefikLabels security headers", () => {
  const base = (): ComposeFile => ({ services: { web: { name: "web", image: "app:latest" } } });
  const opts = { projectName: "site-abc", appName: "site", domain: "site.test", containerPort: 80, securityHeaders: true };
  const headerLabels = (labels: Record<string, string>) =>
    Object.fromEntries(Object.entries(labels).filter(([k]) => k.startsWith("traefik.http.middlewares.site-abc-headers.")));

  it("defines the headers middleware and puts it on the HTTPS router only", () => {
    const labels = injectTraefikLabels(base(), opts).services.web.labels!;
    expect(headerLabels(labels)).toEqual({
      "traefik.http.middlewares.site-abc-headers.headers.stsSeconds": "31536000",
      "traefik.http.middlewares.site-abc-headers.headers.contentTypeNosniff": "true",
      "traefik.http.middlewares.site-abc-headers.headers.customFrameOptionsValue": "SAMEORIGIN",
      "traefik.http.middlewares.site-abc-headers.headers.referrerPolicy": "strict-origin-when-cross-origin",
    });
    expect(labels["traefik.http.routers.site-abc.middlewares"]).toBe("site-abc-headers");
    expect(labels["traefik.http.routers.site-abc-http.middlewares"]).toBe("site-abc-https-redirect");
  });

  it("sends HSTS without includeSubDomains or preload", () => {
    expect(Object.keys(SECURITY_HEADERS)).not.toContain("stsIncludeSubdomains");
    expect(Object.keys(SECURITY_HEADERS)).not.toContain("stsPreload");
    expect(Object.keys(SECURITY_HEADERS)).not.toContain("contentSecurityPolicy");
  });

  it("runs ahead of the domain's middlewares and the redirect", () => {
    const labels = injectTraefikLabels(base(), {
      ...opts,
      middlewares: ["cloudflare-only@file"],
      redirectTo: "https://new.test",
    }).services.web.labels!;
    expect(labels["traefik.http.routers.site-abc.middlewares"]).toBe("site-abc-headers,cloudflare-only@file,site-abc-redirect");
  });

  it("adds nothing when the app opts out", () => {
    const labels = injectTraefikLabels(base(), { ...opts, securityHeaders: false }).services.web.labels!;
    expect(headerLabels(labels)).toEqual({});
    expect(labels["traefik.http.routers.site-abc.middlewares"]).toBeUndefined();
  });

  it("adds nothing to a plain-HTTP domain", () => {
    const labels = injectTraefikLabels(base(), { ...opts, ssl: false }).services.web.labels!;
    expect(headerLabels(labels)).toEqual({});
    expect(labels["traefik.http.routers.site-abc.middlewares"]).toBeUndefined();
  });

  it("is on by default in applyDeployTransforms and off when the app opts out", () => {
    const domain: DeployTransformDomain = {
      id: "abcdef123456",
      domain: "site.test",
      port: 80,
      sslEnabled: true,
      certResolver: "le-dns",
      redirectTo: null,
      redirectCode: null,
    };
    const run = (securityHeaders?: boolean) =>
      applyDeployTransforms(base(), {
        appName: "site",
        containerPort: 80,
        domains: [domain],
        networkName: "vardo-network",
        securityHeaders,
      }).services.web.labels!["traefik.http.routers.site-abcdef.middlewares"];
    expect(run()).toBe("site-abcdef-headers");
    expect(run(false)).toBeUndefined();
  });

  it("is pruned from a sibling service when the route moves", () => {
    const compose: ComposeFile = {
      services: {
        web: { name: "web", image: "app:latest" },
        api: { name: "api", image: "api:latest" },
      },
    };
    const first = injectTraefikLabels(compose, { ...opts, serviceName: "api" });
    const moved = injectTraefikLabels(first, { ...opts, serviceName: "web" });
    expect(Object.keys(moved.services.api.labels ?? {}).filter((k) => k.includes("site-abc-headers"))).toEqual([]);
  });
});

describe("injectNetwork — keeps the implicit default network (formbricks P1001 regression)", () => {
  const stack = (): ComposeFile => ({
    services: {
      "formbricks-db": {
        name: "formbricks-db",
        image: "pgvector/pgvector:pg17",
        volumes: ["db-data:/var/lib/postgresql/data"],
      },
      formbricks: { name: "formbricks", image: "ghcr.io/formbricks/formbricks:v3.1.5" },
    },
    volumes: { "db-data": null },
  });

  it("lists default alongside vardo-network on a service that named no networks", () => {
    const result = injectNetwork(stack(), NETWORK, { attachTo: new Set(["formbricks"]) });
    expect(result.services.formbricks.networks).toEqual(["default", NETWORK]);
    expect(result.services["formbricks-db"].networks).toBeUndefined();
  });

  it("leaves a service's own networks alone", () => {
    const compose = stack();
    compose.services.formbricks.networks = ["internal"];
    const result = injectNetwork(compose, NETWORK, { attachTo: new Set(["formbricks"]) });
    expect(result.services.formbricks.networks).toEqual(["internal", NETWORK]);
  });

  it("restates default in the overlay so the merged service stays on it", () => {
    const full = injectNetwork(stack(), NETWORK, { attachTo: new Set(["formbricks"]) });
    const overlay = buildVardoOverlay({ fullCompose: full, networkName: NETWORK });
    expect(overlay.services.formbricks.networks).toEqual(["default", NETWORK]);
    expect(overlay.services["formbricks-db"].networks).toBeUndefined();
  });

  it("shares default with the slot even when the shared service is the routed one", () => {
    const full = injectNetwork(stack(), NETWORK, { attachTo: new Set(["formbricks-db"]) });
    expect([...sharedNetworks(full)]).toEqual(["default"]);
  });
});
