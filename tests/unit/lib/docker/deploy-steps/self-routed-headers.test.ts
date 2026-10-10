// A self-routed app's own HTTPS routers reach the slot's compose files with the security headers middleware.

import { describe, it, expect, vi } from "vitest";
import type { ComposeFile } from "@/lib/docker/compose";
import type { DeployContext, DeployApp } from "@/lib/docker/deploy-context";

vi.mock("@/lib/ssl/generate-config", () => ({
  removeAppRouteConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/docker/client", () => ({
  detectExposedPorts: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/docker/label-hosts", () => ({
  assertLabelHostsOwned: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/db", () => ({
  db: { query: { apps: { findMany: vi.fn().mockResolvedValue([]) } } },
}));

import { resolveCompose } from "@/lib/docker/deploy-steps/resolve-compose";
import { buildVardoOverlay } from "@/lib/docker/compose-inject";
import { slotComposePair } from "@/lib/docker/traefik-slot-names";
import { nonRotatingServices } from "@/lib/docker/slot-partition";
import { VARDO_SELF_APP_NAME } from "@/lib/api/system-managed";

function mailCompose(): ComposeFile {
  const router = (name: string, host: string) => ({
    [`traefik.http.routers.${name}.rule`]: `Host(\`${host}\`)`,
    [`traefik.http.routers.${name}.entrypoints`]: "websecure",
    [`traefik.http.routers.${name}.tls.certresolver`]: "le-dns",
    [`traefik.http.routers.${name}.service`]: "mail",
  });
  return {
    name: "mail",
    services: {
      mail: {
        name: "mail",
        image: "mail:latest",
        labels: {
          "vardo.traefik": "manual",
          "traefik.enable": "true",
          ...router("mail", "mail.example.net"),
          ...router("mail-alt", "mail.example.org"),
          ...router("mail-smtp-cert", "smtp.example.net"),
          "traefik.http.routers.mail-http.rule": "Host(`mail.example.net`)",
          "traefik.http.routers.mail-http.entrypoints": "web",
          "traefik.http.routers.mail-http.middlewares": "to-https@file",
          "traefik.http.services.mail.loadbalancer.server.port": "3000",
        },
      },
      postgres: { name: "postgres", image: "postgres:17" },
    },
  };
}

function makeCtx(name: string, overrides: Partial<DeployApp> = {}): DeployContext {
  const compose = mailCompose();
  const app = {
    id: "app-id",
    organizationId: "org-id",
    name,
    displayName: name,
    source: "git",
    deployType: "compose",
    containerPort: null,
    restartPolicy: "unless-stopped",
    gpuEnabled: false,
    backendProtocol: null,
    autoTraefikLabels: false,
    domains: [],
    ...overrides,
  } as unknown as DeployApp;
  return {
    deploymentId: "dep-id",
    appId: app.id,
    organizationId: app.organizationId,
    app,
    envName: "production",
    envType: "production",
    envIsolated: false,
    orgTrusted: true,
    org: { id: "org-id", name: "org", baseDomain: null, trusted: true, isSystemManaged: name === VARDO_SELF_APP_NAME },
    envMap: {},
    compose,
    bareCompose: compose,
    builtLocally: false,
    log: (line: string) => line,
  } as unknown as DeployContext;
}

/** The labels `docker compose -f bare -f overlay` gives the mail container. */
async function slotLabels(ctx: DeployContext, slot = "blue"): Promise<Record<string, string>> {
  const resolved = await resolveCompose(ctx);
  const { full, bare } = slotComposePair(
    resolved.compose,
    resolved.bareCompose,
    slot,
    nonRotatingServices(resolved.compose),
  );
  const overlay = buildVardoOverlay({ fullCompose: full, networkName: "vardo-network" });
  return { ...bare.services.mail.labels, ...overlay.services.mail?.labels };
}

describe("self-routed app through resolve, slot naming and overlay", () => {
  it("puts the slot's headers middleware on the websecure routers only", async () => {
    const labels = await slotLabels(makeCtx("mail"));
    for (const router of ["mail", "mail-alt", "mail-smtp-cert"]) {
      expect(labels[`traefik.http.routers.app-id-${router}-blue.middlewares`]).toBe("mail-vardo-headers-blue");
    }
    expect(labels["traefik.http.routers.app-id-mail-http-blue.middlewares"]).toBe("to-https@file");
    expect(labels["traefik.http.middlewares.mail-vardo-headers-blue.headers.stsSeconds"]).toBe("31536000");
  });

  it("names the middleware per slot on green", async () => {
    const labels = await slotLabels(makeCtx("mail"), "green");
    expect(labels["traefik.http.routers.app-id-mail-green.middlewares"]).toBe("mail-vardo-headers-green");
    expect(labels["traefik.http.middlewares.mail-vardo-headers-green.headers.stsSeconds"]).toBe("31536000");
  });

  it("adds nothing when the app opts out", async () => {
    const labels = await slotLabels(makeCtx("mail", { securityHeaders: false }));
    expect(Object.keys(labels).filter((k) => k.includes("vardo-headers"))).toEqual([]);
    expect(labels["traefik.http.routers.app-id-mail-blue.middlewares"]).toBeUndefined();
  });

  it("adds nothing to the console's own routers", async () => {
    const labels = await slotLabels(makeCtx(VARDO_SELF_APP_NAME));
    expect(Object.keys(labels).filter((k) => k.includes("vardo-headers"))).toEqual([]);
  });
});
