import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: {
        findFirst: vi.fn(),
      },
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

import { regenerateAppRouteConfig, buildTraefikConfigYaml } from "@/lib/traefik/generate-config";
import { db } from "@/lib/db";
import * as fsp from "fs/promises";
import YAML from "yaml";

function makeErrnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: operation failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// Minimal app record with one domain — enough to reach the mkdir/writeFile paths
const mockApp = {
  id: "app-123",
  name: "test-app",
  containerPort: 3000,
  containerName: "test-app-production-blue-web-1",
  domains: [
    {
      id: "dom-12345678",
      domain: "example.com",
      sslEnabled: false,
      certResolver: null,
      redirectTo: null,
      redirectCode: null,
    },
  ],
};

describe("regenerateAppRouteConfig — mkdir error handling", () => {
  beforeEach(() => {
    vi.mocked(db.query.apps.findFirst).mockResolvedValue(mockApp as never);
  });

  it("returns silently when mkdir fails with EACCES", async () => {
    vi.mocked(fsp.mkdir).mockRejectedValueOnce(makeErrnoError("EACCES"));
    await expect(regenerateAppRouteConfig("app-123")).resolves.toBeUndefined();
  });

  it("returns silently when mkdir fails with ENOENT", async () => {
    vi.mocked(fsp.mkdir).mockRejectedValueOnce(makeErrnoError("ENOENT"));
    await expect(regenerateAppRouteConfig("app-123")).resolves.toBeUndefined();
  });

  it("re-throws when mkdir fails with an unexpected error code", async () => {
    vi.mocked(fsp.mkdir).mockRejectedValueOnce(makeErrnoError("EPERM"));
    await expect(regenerateAppRouteConfig("app-123")).rejects.toThrow();
  });

  it("re-throws when mkdir fails with a plain Error (no code)", async () => {
    vi.mocked(fsp.mkdir).mockRejectedValueOnce(new Error("unexpected"));
    await expect(regenerateAppRouteConfig("app-123")).rejects.toThrow("unexpected");
  });
});

describe("regenerateAppRouteConfig — writeFile/rename error handling", () => {
  beforeEach(() => {
    vi.mocked(db.query.apps.findFirst).mockResolvedValue(mockApp as never);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fsp.rename).mockResolvedValue(undefined as never);
  });

  it("returns silently when writeFile fails with EACCES", async () => {
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(makeErrnoError("EACCES"));
    await expect(regenerateAppRouteConfig("app-123")).resolves.toBeUndefined();
  });

  it("returns silently when writeFile fails with ENOENT", async () => {
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(makeErrnoError("ENOENT"));
    await expect(regenerateAppRouteConfig("app-123")).resolves.toBeUndefined();
  });

  it("re-throws when writeFile fails with an unexpected error code", async () => {
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(makeErrnoError("EPERM"));
    await expect(regenerateAppRouteConfig("app-123")).rejects.toThrow();
  });

  it("re-throws when rename fails with an unexpected error code", async () => {
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined as never);
    vi.mocked(fsp.rename).mockRejectedValueOnce(makeErrnoError("EPERM"));
    await expect(regenerateAppRouteConfig("app-123")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildTraefikConfigYaml — config generation logic
// ---------------------------------------------------------------------------

function makeDomain(overrides: Partial<{
  id: string;
  domain: string;
  sslEnabled: boolean | null;
  certResolver: string | null;
  redirectTo: string | null;
  redirectCode: number | null;
}> = {}) {
  return {
    id: "dom-12345678",
    domain: "example.com",
    sslEnabled: null,
    certResolver: null,
    redirectTo: null,
    redirectCode: null,
    ...overrides,
  };
}

describe("buildTraefikConfigYaml — empty domains", () => {
  it("returns null when domain list is empty", () => {
    expect(buildTraefikConfigYaml("myapp", [])).toBeNull();
  });
});

describe("buildTraefikConfigYaml — HTTP-only domain", () => {
  it("creates a single web-entrypoint router with no TLS", () => {
    const yaml = buildTraefikConfigYaml("myapp", [makeDomain({ sslEnabled: false })]);
    expect(yaml).not.toBeNull();
    const config = YAML.parse(yaml!);
    const routers = config.http.routers;
    const routerName = "myapp-dom-1234";
    expect(routers[routerName]).toBeDefined();
    expect(routers[routerName].entryPoints).toEqual(["web"]);
    expect(routers[routerName].tls).toBeUndefined();
    // No http-redirect router for HTTP-only
    expect(routers[`${routerName}-http`]).toBeUndefined();
    // No redirect middleware
    expect(config.http.middlewares).toBeUndefined();
  });
});

describe("buildTraefikConfigYaml — SSL with external domain", () => {
  it("creates websecure router with certResolver and an http-to-https redirect router", () => {
    const yaml = buildTraefikConfigYaml("myapp", [
      makeDomain({ domain: "example.com", sslEnabled: true, certResolver: "le" }),
    ]);
    expect(yaml).not.toBeNull();
    const config = YAML.parse(yaml!);
    const routers = config.http.routers;
    const routerName = "myapp-dom-1234";

    // HTTPS router
    expect(routers[routerName].entryPoints).toEqual(["websecure"]);
    expect(routers[routerName].tls).toEqual({ certResolver: "le" });

    // HTTP → HTTPS redirect router
    const httpRouter = routers[`${routerName}-http`];
    expect(httpRouter).toBeDefined();
    expect(httpRouter.entryPoints).toEqual(["web"]);
    expect(httpRouter.middlewares).toHaveLength(1);

    // Redirect middleware must be a redirectScheme to https
    const mwName = httpRouter.middlewares[0];
    expect(config.http.middlewares[mwName].redirectScheme).toEqual({
      scheme: "https",
      permanent: true,
    });
  });

  it("uses 'le' as the default certResolver when none is specified", () => {
    const yaml = buildTraefikConfigYaml("myapp", [
      makeDomain({ domain: "example.com", sslEnabled: true, certResolver: null }),
    ]);
    const config = YAML.parse(yaml!);
    expect(config.http.routers["myapp-dom-1234"].tls).toEqual({ certResolver: "le" });
  });
});

describe("buildTraefikConfigYaml — local TLS (.localhost domain)", () => {
  it("creates websecure router with empty tls and http router without redirect", () => {
    const yaml = buildTraefikConfigYaml("myapp", [
      makeDomain({ domain: "myapp.localhost", sslEnabled: true }),
    ]);
    expect(yaml).not.toBeNull();
    const config = YAML.parse(yaml!);
    const routers = config.http.routers;
    const routerName = "myapp-dom-1234";

    // HTTPS router has empty tls (no certResolver for local)
    expect(routers[routerName].entryPoints).toEqual(["websecure"]);
    expect(routers[routerName].tls).toEqual({});
    expect(routers[routerName].tls?.certResolver).toBeUndefined();

    // HTTP router exists but has no redirect middleware
    const httpRouter = routers[`${routerName}-http`];
    expect(httpRouter).toBeDefined();
    expect(httpRouter.entryPoints).toEqual(["web"]);
    expect(httpRouter.middlewares).toBeUndefined();
  });
});

describe("buildTraefikConfigYaml — redirect domain", () => {
  it("creates redirectRegex middleware and attaches it to both routers when SSL", () => {
    const yaml = buildTraefikConfigYaml("myapp", [
      makeDomain({
        domain: "old.example.com",
        sslEnabled: true,
        certResolver: "le",
        redirectTo: "https://new.example.com",
        redirectCode: 301,
      }),
    ]);
    expect(yaml).not.toBeNull();
    const config = YAML.parse(yaml!);
    const routers = config.http.routers;
    const routerName = "myapp-dom-1234";

    // Both routers carry the redirect middleware
    expect(routers[routerName].middlewares).toHaveLength(1);
    expect(routers[`${routerName}-http`].middlewares).toHaveLength(1);

    const mwName = routers[routerName].middlewares[0];
    const mw = config.http.middlewares[mwName];
    expect(mw.redirectRegex).toBeDefined();
    expect(mw.redirectRegex.replacement).toBe("https://new.example.com${1}");
    expect(mw.redirectRegex.permanent).toBe(true);
  });

  it("marks redirect as non-permanent when redirectCode is 302", () => {
    const yaml = buildTraefikConfigYaml("myapp", [
      makeDomain({
        domain: "old.example.com",
        sslEnabled: false,
        redirectTo: "https://new.example.com",
        redirectCode: 302,
      }),
    ]);
    const config = YAML.parse(yaml!);
    const routers = config.http.routers;
    const mwName = routers["myapp-dom-1234"].middlewares[0];
    expect(config.http.middlewares[mwName].redirectRegex.permanent).toBe(false);
  });

  it("creates only a web router for HTTP-only redirect", () => {
    const yaml = buildTraefikConfigYaml("myapp", [
      makeDomain({
        domain: "old.example.com",
        sslEnabled: false,
        redirectTo: "https://new.example.com",
        redirectCode: 301,
      }),
    ]);
    const config = YAML.parse(yaml!);
    const routers = config.http.routers;
    expect(routers["myapp-dom-1234"].entryPoints).toEqual(["web"]);
    expect(routers["myapp-dom-1234-http"]).toBeUndefined();
  });
});

describe("buildTraefikConfigYaml — multiple domains", () => {
  it("generates separate routers for each domain", () => {
    const yaml = buildTraefikConfigYaml("myapp", [
      makeDomain({ id: "aaa-11111111", domain: "a.example.com", sslEnabled: false }),
      makeDomain({ id: "bbb-22222222", domain: "b.example.com", sslEnabled: false }),
    ]);
    const config = YAML.parse(yaml!);
    expect(config.http.routers["myapp-aaa-1111"]).toBeDefined();
    expect(config.http.routers["myapp-bbb-2222"]).toBeDefined();
  });

  it("falls back to @docker service ref when no containerName provided", () => {
    const yaml = buildTraefikConfigYaml("myapp", [makeDomain({ sslEnabled: false })]);
    const config = YAML.parse(yaml!);
    expect(config.http.routers["myapp-dom-1234"].service).toBe("myapp@docker");
    expect(config.http.services).toBeUndefined();
  });

  it("defines an inline service when containerName is provided", () => {
    const yaml = buildTraefikConfigYaml(
      "myapp",
      [makeDomain({ sslEnabled: false })],
      null,
      "myapp-production-blue-web-1",
      8080,
    );
    const config = YAML.parse(yaml!);
    expect(config.http.routers["myapp-dom-1234"].service).toBe("myapp");
    expect(config.http.services.myapp.loadBalancer.servers).toEqual([
      { url: "http://myapp-production-blue-web-1:8080" },
    ]);
  });

  it("uses https in service URL when backendProtocol is https", () => {
    const yaml = buildTraefikConfigYaml(
      "myapp",
      [makeDomain({ sslEnabled: false })],
      "https",
      "myapp-production-blue-web-1",
      443,
    );
    const config = YAML.parse(yaml!);
    expect(config.http.services.myapp.loadBalancer.servers).toEqual([
      { url: "https://myapp-production-blue-web-1:443" },
    ]);
    expect(config.http.services.myapp.loadBalancer.serversTransport).toBe("myapp-insecure");
  });

  it("defaults to port 3000 when containerPort is null", () => {
    const yaml = buildTraefikConfigYaml(
      "myapp",
      [makeDomain({ sslEnabled: false })],
      null,
      "myapp-production-blue-web-1",
      null,
    );
    const config = YAML.parse(yaml!);
    expect(config.http.services.myapp.loadBalancer.servers).toEqual([
      { url: "http://myapp-production-blue-web-1:3000" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildTraefikConfigYaml — HTTPS backend
// ---------------------------------------------------------------------------

describe("buildTraefikConfigYaml — HTTPS backend", () => {
  it("adds insecure serversTransport when backendProtocol is https", () => {
    const yaml = buildTraefikConfigYaml(
      "myapp",
      [makeDomain({ sslEnabled: false })],
      "https",
    );
    expect(yaml).not.toBeNull();
    const config = YAML.parse(yaml!);
    expect(config.http.serversTransports).toBeDefined();
    expect(config.http.serversTransports["myapp-insecure"]).toEqual({ insecureSkipVerify: true });
  });

  it.each<["http" | null | undefined, string]>([
    ["http", "http"],
    [null, "null"],
    [undefined, "omitted"],
  ])("does not add serversTransport when backendProtocol is %s", (protocol) => {
    const yaml = buildTraefikConfigYaml(
      "myapp",
      [makeDomain({ sslEnabled: false })],
      protocol,
    );
    expect(yaml).not.toBeNull();
    const config = YAML.parse(yaml!);
    expect(config.http.serversTransports).toBeUndefined();
  });

  it("names the serversTransport key after the app", () => {
    const yaml = buildTraefikConfigYaml(
      "coolapp",
      [makeDomain({ sslEnabled: false })],
      "https",
    );
    const config = YAML.parse(yaml!);
    expect(config.http.serversTransports["coolapp-insecure"]).toBeDefined();
  });
});
