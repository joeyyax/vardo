// A self-routed app's own HTTPS routers reach the slot's compose files with the security headers middleware.

import { beforeEach, describe, it, expect, vi } from "vitest";
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
const volume = vi.hoisted(() => ({ present: true }));
vi.mock("@/lib/docker/headers-file", async () => {
  const { headersLabelOptions, headersMiddlewareRef } = await import("@/lib/security/response-headers");
  return {
    deployHeadersMiddleware: vi.fn(async (id: string, config: Parameters<typeof headersLabelOptions>[0]) => {
      if (volume.present) return { headers: { ref: headersMiddlewareRef(id) }, live: true };
      const options = headersLabelOptions(config);
      return { headers: Object.keys(options).length > 0 ? { options } : null, live: false };
    }),
  };
});

import { resolveCompose } from "@/lib/docker/deploy-steps/resolve-compose";
import { buildVardoOverlay } from "@/lib/docker/compose-inject";
import { slotComposePair } from "@/lib/docker/traefik-slot-names";
import { nonRotatingServices } from "@/lib/docker/slot-partition";
import { VARDO_SELF_APP_NAME } from "@/lib/api/system-managed";
import { OFF_HEADERS } from "@/lib/security/response-headers";

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
  beforeEach(() => {
    volume.present = true;
  });

  it("references the same file middleware from both slots, on websecure routers only", async () => {
    for (const slot of ["blue", "green"]) {
      const labels = await slotLabels(makeCtx("mail"), slot);
      for (const router of ["mail", "mail-alt", "mail-smtp-cert"]) {
        expect(labels[`traefik.http.routers.app-id-${router}-${slot}.middlewares`]).toBe("vardo-headers-app-id@file");
      }
      expect(labels[`traefik.http.routers.app-id-mail-http-${slot}.middlewares`]).toBe("to-https@file");
      expect(Object.keys(labels).filter((k) => k.startsWith("traefik.http.middlewares."))).toEqual([]);
    }
  });

  it("keeps the reference with every header off, so turning one on later applies live", async () => {
    const ctx = makeCtx("mail", { securityHeaders: OFF_HEADERS });
    const labels = await slotLabels(ctx);
    expect(labels["traefik.http.routers.app-id-mail-blue.middlewares"]).toBe("vardo-headers-app-id@file");
    expect(ctx.headersLive).toBe(true);
  });

  it("falls back to per-slot label headers without a Traefik volume", async () => {
    volume.present = false;
    const ctx = makeCtx("mail");
    const labels = await slotLabels(ctx, "green");
    expect(labels["traefik.http.routers.app-id-mail-green.middlewares"]).toBe("mail-vardo-headers-green");
    expect(labels["traefik.http.middlewares.mail-vardo-headers-green.headers.stsSeconds"]).toBe("31536000");
    expect(ctx.headersLive).toBe(false);
  });

  it("adds nothing without a Traefik volume when every header is off", async () => {
    volume.present = false;
    const labels = await slotLabels(makeCtx("mail", { securityHeaders: OFF_HEADERS }));
    expect(Object.keys(labels).filter((k) => k.includes("vardo-headers"))).toEqual([]);
    expect(labels["traefik.http.routers.app-id-mail-blue.middlewares"]).toBeUndefined();
  });

  it("adds nothing to the console's own routers", async () => {
    const labels = await slotLabels(makeCtx(VARDO_SELF_APP_NAME));
    expect(Object.keys(labels).filter((k) => k.includes("vardo-headers"))).toEqual([]);
  });
});
