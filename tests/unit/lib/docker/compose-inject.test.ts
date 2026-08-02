import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  TRAEFIK_MANUAL_LABEL,
  applyDeployTransforms,
  buildVardoOverlay,
  injectTraefikLabels,
  isTraefikSelfRouted,
  stripTraefikLabels,
  stripVardoInjections,
} from "@/lib/docker/compose-inject";
import { parseCompose } from "@/lib/docker/compose-parse";
import { selectRoutedService } from "@/lib/docker/routed-service";
import type { ComposeFile } from "@/lib/docker/compose-types";

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
  composeService: null,
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
