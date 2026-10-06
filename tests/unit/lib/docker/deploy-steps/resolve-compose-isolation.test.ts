// ---------------------------------------------------------------------------
// resolveCompose for a preview: the repo's compose describes production, so
// its hand-written routers and production names must never reach a preview
// container. Production's own names are pinned: live routers carry them.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import type { ComposeFile } from "@/lib/docker/compose";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

vi.mock("@/lib/ssl/generate-config", () => ({
  removeAppRouteConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/docker/client", () => ({
  detectExposedPorts: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/db", () => ({
  db: { query: { apps: { findMany: vi.fn().mockResolvedValue([]) } } },
}));

import { resolveCompose } from "@/lib/docker/deploy-steps/resolve-compose";
import { removeAppRouteConfig } from "@/lib/ssl/generate-config";

type Domain = DeployApp["domains"][number];

function makeApp(domains: Partial<Domain>[], overrides: Partial<DeployApp> = {}): DeployApp {
  return {
    id: "app-id",
    organizationId: "org-id",
    name: "notes-api",
    displayName: "Knowledge",
    source: "git",
    deployType: "compose",
    containerPort: null,
    restartPolicy: "unless-stopped",
    gpuEnabled: false,
    backendProtocol: null,
    domains: domains as Domain[],
    ...overrides,
  } as DeployApp;
}

function makeCtx(compose: ComposeFile, app: DeployApp, env: { name: string; isolated: boolean }): DeployContext {
  const logLines: string[] = [];
  return {
    deploymentId: "dep-id",
    appId: app.id,
    organizationId: app.organizationId,
    app,
    envName: env.name,
    envType: env.isolated ? "preview" : "production",
    envIsolated: env.isolated,
    envMap: {},
    compose,
    bareCompose: compose,
    builtLocally: false,
    log: (line: string) => {
      logLines.push(line);
      return line;
    },
    logs: { push: (line: string) => logLines.push(line) },
    logLines,
  } as unknown as DeployContext;
}

/** The repo compose: hand-written routing for the production host. */
function repoCompose(): ComposeFile {
  return {
    name: "knowledge",
    services: {
      web: {
        name: "web",
        image: "knowledge:latest",
        labels: {
          "traefik.enable": "true",
          "traefik.http.routers.knowledge.rule": "Host(`knowledge.example.com`)",
          "traefik.http.routers.knowledge.entrypoints": "websecure",
          "traefik.http.services.knowledge.loadbalancer.server.port": "3500",
        },
      },
      embed: {
        name: "embed",
        image: "embed:latest",
        container_name: "knowledge-embed",
        labels: {
          "vardo.traefik": "manual",
          "traefik.enable": "true",
          "traefik.http.routers.embed.rule": "Host(`embed.example.com`)",
          "traefik.http.services.embed.loadbalancer.server.port": "8080",
        },
      },
    },
  };
}

const PREVIEW_DOMAIN = {
  id: "env-pr-25-abcdef",
  domain: "notes-api-pr-25.example.com",
  isPrimary: true,
  port: null,
  sslEnabled: true,
  certResolver: "le-dns",
  redirectTo: null,
  redirectCode: 301,
  composeService: null,
};

function allLabels(compose: ComposeFile): Record<string, string> {
  return Object.assign({}, ...Object.values(compose.services).map((s) => s.labels ?? {}));
}

describe("resolveCompose — preview environment", () => {
  async function preview() {
    const app = makeApp([{ ...PREVIEW_DOMAIN }]);
    return resolveCompose(makeCtx(repoCompose(), app, { name: "pr-25", isolated: true }));
  }

  it("carries only the preview host", async () => {
    const ctx = await preview();
    const rules = Object.entries(allLabels(ctx.compose))
      .filter(([k]) => k.endsWith(".rule"))
      .map(([, v]) => v);

    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).toBe("Host(`notes-api-pr-25.example.com`)");
  });

  it("drops the repo's hand-written production routers from both compose files", async () => {
    const ctx = await preview();
    for (const file of [ctx.compose, ctx.bareCompose]) {
      const text = JSON.stringify(file);
      expect(text).not.toContain("knowledge.example.com");
      expect(text).not.toContain("embed.example.com");
      expect(text).not.toContain("traefik.http.routers.knowledge.");
    }
  });

  it("puts the environment in every router and service name", async () => {
    const ctx = await preview();
    const names = Object.keys(allLabels(ctx.compose))
      .map((k) => /^traefik\.http\.(?:routers|services|middlewares)\.([^.]+)\./.exec(k)?.[1])
      .filter((n): n is string => !!n);

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^notes-api-pr-25(-|$)/);
  });

  it("routes where the hand-written labels pointed", async () => {
    const ctx = await preview();
    const web = ctx.compose.services.web.labels ?? {};

    expect(web["traefik.http.services.notes-api-pr-25.loadbalancer.server.port"]).toBe("3500");
  });

  it("drops the fixed container_name and the compose name", async () => {
    const ctx = await preview();

    expect(ctx.compose.services.embed.container_name).toBeUndefined();
    expect(ctx.bareCompose.services.embed.container_name).toBeUndefined();
    expect(ctx.compose.name).toBeUndefined();
  });

  it("leaves the production app's file-provider config alone", async () => {
    vi.mocked(removeAppRouteConfig).mockClear();
    await preview();

    expect(removeAppRouteConfig).not.toHaveBeenCalled();
  });
});

describe("resolveCompose — production names", () => {
  it("are unchanged", async () => {
    const app = makeApp([
      {
        id: "dom-id-abcdef12",
        domain: "knowledge.example.com",
        isPrimary: true,
        port: 3500,
        sslEnabled: true,
        certResolver: "le-dns",
        redirectTo: null,
        redirectCode: 301,
      },
    ]);
    const compose: ComposeFile = { services: { web: { name: "web", image: "knowledge:latest" } } };
    const ctx = await resolveCompose(makeCtx(compose, app, { name: "production", isolated: false }));

    const traefik = Object.fromEntries(
      Object.entries(ctx.compose.services.web.labels ?? {}).filter(([k]) => k.startsWith("traefik.")),
    );
    expect(traefik).toEqual({
      "traefik.enable": "true",
      "traefik.http.routers.notes-api-dom-id-a.rule": "Host(`knowledge.example.com`)",
      "traefik.http.services.notes-api.loadbalancer.server.port": "3500",
      "traefik.http.routers.notes-api-dom-id-a.service": "notes-api",
      "traefik.http.routers.notes-api-dom-id-a.entrypoints": "websecure",
      "traefik.http.routers.notes-api-dom-id-a.tls": "true",
      "traefik.http.routers.notes-api-dom-id-a.tls.certresolver": "le-dns",
      "traefik.http.routers.notes-api-dom-id-a-http.rule": "Host(`knowledge.example.com`)",
      "traefik.http.routers.notes-api-dom-id-a-http.entrypoints": "web",
      "traefik.http.routers.notes-api-dom-id-a-http.service": "notes-api",
      "traefik.http.middlewares.notes-api-dom-id-a-https-redirect.redirectscheme.scheme": "https",
      "traefik.http.middlewares.notes-api-dom-id-a-https-redirect.redirectscheme.permanent": "true",
      "traefik.http.routers.notes-api-dom-id-a-http.middlewares": "notes-api-dom-id-a-https-redirect",
    });
  });

  it("keep the https transport name", async () => {
    const app = makeApp(
      [{ id: "dom-id-abcdef12", domain: "knowledge.example.com", isPrimary: true, port: 3500, sslEnabled: true }],
      { backendProtocol: "https" },
    );
    const compose: ComposeFile = { services: { web: { name: "web", image: "knowledge:latest" } } };
    const ctx = await resolveCompose(makeCtx(compose, app, { name: "production", isolated: false }));

    expect(ctx.compose.services.web.labels?.["traefik.http.services.notes-api.loadbalancer.serversTransport"]).toBe(
      "notes-api-insecure@file",
    );
  });
});
